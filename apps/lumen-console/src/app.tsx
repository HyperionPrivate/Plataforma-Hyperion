import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { LoadingState } from "./components/ui.js";
import { ApiError, SessionExpiredError, loadLumenSession, login, logout } from "./lib/api.js";
import { LumenContext, type ClinicalFacility } from "./lib/context.js";
import { isLumenRoute, LUMEN_VIEWS, lumenViewHref } from "./lib/lumen-navigation.js";
import type { LumenSession } from "./lib/session.js";
import { viewGrantFor } from "./lib/session.js";
import { LumenPage } from "./pages/LumenPage.js";

type SessionState =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "ready"; session: LumenSession }
  | { status: "error"; message: string };

export function App() {
  if (!isLumenRoute(window.location.pathname)) return <NotFound />;
  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refreshSession = useCallback(async () => {
    setState({ status: "loading" });
    try {
      setState({ status: "ready", session: await loadLumenSession() });
    } catch (error) {
      if (error instanceof SessionExpiredError) {
        setState({ status: "anonymous" });
        return;
      }
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  useEffect(() => {
    void refreshSession();
    const handleExpired = () => setState({ status: "anonymous" });
    window.addEventListener("lumen:session-expired", handleExpired);
    return () => window.removeEventListener("lumen:session-expired", handleExpired);
  }, [refreshSession]);

  if (state.status === "loading") {
    return (
      <main className="login-shell">
        <LoadingState label="Conectando con LUMEN..." />
      </main>
    );
  }

  if (state.status === "anonymous") {
    return <Login onLogin={(session) => setState({ status: "ready", session })} />;
  }

  if (state.status === "error") {
    return (
      <StatusPage code="503" title="LUMEN no está disponible" detail={state.message}>
        <button className="btn btn-primary" type="button" onClick={() => void refreshSession()}>
          Reintentar
        </button>
      </StatusPage>
    );
  }

  return <AuthorizedConsole session={state.session} onSessionEnded={() => setState({ status: "anonymous" })} />;
}

function AuthorizedConsole({ session, onSessionEnded }: { session: LumenSession; onSessionEnded: () => void }) {
  const grant = viewGrantFor(session);
  const tenant = grant ? session.tenants.find((candidate) => candidate.id === grant.tenantId) : undefined;
  const [facilities, setFacilities] = useState<ClinicalFacility[]>([]);
  const [activeFacilityId, setActiveFacilityId] = useState<string | "all">("all");

  const replaceClinicalFacilities = useCallback((next: ClinicalFacility[]) => {
    setFacilities(next);
    setActiveFacilityId((current) =>
      current === "all" || next.some((facility) => facility.id === current) ? current : "all"
    );
  }, []);

  const endSession = useCallback(() => {
    void logout();
    onSessionEnded();
  }, [onSessionEnded]);

  const contextValue = useMemo(
    () =>
      grant && tenant
        ? {
            session,
            grant,
            tenant,
            facilities,
            activeFacilityId,
            setActiveFacilityId,
            replaceClinicalFacilities,
            logout: endSession
          }
        : undefined,
    [activeFacilityId, endSession, facilities, grant, replaceClinicalFacilities, session, tenant]
  );

  if (!grant) {
    return (
      <StatusPage
        code="403"
        title="Acceso LUMEN no autorizado"
        detail="Tu sesión no tiene un grant tenant × producto con la capacidad lumen:read."
      >
        <button className="btn btn-outline" type="button" onClick={endSession}>
          Cerrar sesión
        </button>
      </StatusPage>
    );
  }

  if (!contextValue) {
    return (
      <StatusPage
        code="403"
        title="Tenant clínico no autorizado"
        detail="El tenant del grant LUMEN no está presente en la proyección de sesión."
      >
        <button className="btn btn-outline" type="button" onClick={endSession}>
          Cerrar sesión
        </button>
      </StatusPage>
    );
  }

  return (
    <LumenContext.Provider value={contextValue}>
      <Routes>
        <Route path="/" element={<SafeLumenRedirect />} />
        <Route path="/lumen" element={<SafeLumenRedirect />} />
        <Route path="/lumen/:view" element={<KnownLumenView />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </LumenContext.Provider>
  );
}

function KnownLumenView() {
  const { view } = useParams();
  if (!LUMEN_VIEWS.some((candidate) => candidate.id === view)) return <NotFound />;
  return <LumenPage />;
}

function SafeLumenRedirect() {
  const location = useLocation();
  return <Navigate to={lumenViewHref("preconsulta", location)} replace />;
}

function Login({ onLogin }: { onLogin: (session: LumenSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      onLogin(await login(email, password));
    } catch (nextError) {
      setError(
        nextError instanceof ApiError && nextError.status === 403
          ? "La cuenta no tiene acceso a LUMEN."
          : nextError instanceof Error
            ? nextError.message
            : "No fue posible iniciar sesión."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">LUMEN</div>
        <div className="login-title">Espacio clínico</div>
        <p className="login-copy">Accede con tu cuenta institucional.</p>
        <label className="login-field">
          Correo
          <input
            className="input"
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label className="login-field">
          Contraseña
          <input
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? (
          <div className="login-error" role="alert">
            {error}
          </div>
        ) : null}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </main>
  );
}

function NotFound() {
  return <StatusPage code="404" title="Ruta no encontrada" detail="Esta ruta no pertenece a LUMEN." />;
}

function StatusPage({
  code,
  title,
  detail,
  children
}: {
  code: string;
  title: string;
  detail: string;
  children?: ReactNode;
}) {
  return (
    <main className="status-shell">
      <section className="status-card">
        <span className="status-code">{code}</span>
        <h1>{title}</h1>
        <p>{detail}</p>
        {children}
      </section>
    </main>
  );
}
