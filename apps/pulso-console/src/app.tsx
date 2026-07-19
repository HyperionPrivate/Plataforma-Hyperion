import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { PulsoIrisSite } from "@hyperion/pulso-contracts";
import { Login } from "./components/Login.js";
import { LoadingState } from "./components/ui.js";
import { api, SessionExpiredError } from "./lib/api.js";
import { ConsoleContext, tenantPath, type TenantInfo } from "./lib/context.js";
import { logout, pulsoGrantFor, readSession, type PulsoSession } from "./lib/session.js";
import { isPulsoRoute } from "./lib/routes.js";
import { AgendaPage } from "./pages/AgendaPage.js";
import { BiPage } from "./pages/BiPage.js";
import { CampaignsPage } from "./pages/CampaignsPage.js";
import { ConfigPage } from "./pages/ConfigPage.js";
import { ConversationsPage } from "./pages/ConversationsPage.js";
import { OperationPage } from "./pages/OperationPage.js";
import { RpaPage } from "./pages/RpaPage.js";

function StatusPage({ code, title, children }: { code: string; title: string; children: ReactNode }) {
  return (
    <main className="login-shell" id="main-content">
      <div className="login-card">
        <div className="login-title">
          {code} · {title}
        </div>
        <p className="login-copy">{children}</p>
        <a className="btn btn-primary" href="/operacion">
          Volver a PULSO
        </a>
      </div>
    </main>
  );
}

export function App() {
  const [session, setSession] = useState<PulsoSession>();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    readSession()
      .then(setSession)
      .finally(() => setReady(true));
  }, []);
  const onLogout = useCallback(() => {
    void logout();
    setSession(undefined);
  }, []);
  if (!isPulsoRoute(window.location.pathname)) {
    return (
      <StatusPage code="404" title="Ruta inexistente">
        Esta consola solo publica flujos de PULSO IRIS.
      </StatusPage>
    );
  }
  if (!ready)
    return (
      <main className="login-shell">
        <LoadingState label="Conectando con PULSO…" />
      </main>
    );
  if (!session) return <Login onLogin={setSession} />;
  return <ConsoleShell session={session} onLogout={onLogout} />;
}

function ConsoleShell({ session, onLogout }: { session: PulsoSession; onLogout: () => void }) {
  const [tenant, setTenant] = useState<TenantInfo>();
  const [sites, setSites] = useState<PulsoIrisSite[]>([]);
  const [activeSiteId, setActiveSiteId] = useState<string | "all">("all");
  const [ready, setReady] = useState(false);
  const eligibleTenants = useMemo(
    () => session.tenants.filter((candidate) => Boolean(pulsoGrantFor(session, candidate.id))),
    [session]
  );
  useEffect(() => {
    let active = true;
    const selected = eligibleTenants[0];
    if (!selected) {
      setReady(true);
      return;
    }
    api
      .get<PulsoIrisSite[]>(tenantPath(selected.id, "config/sites"))
      .catch(() => [])
      .then((rows) => {
        if (!active) return;
        setTenant(selected);
        setSites(rows);
        setReady(true);
      })
      .catch((reason) => {
        if (reason instanceof SessionExpiredError) onLogout();
        else setReady(true);
      });
    return () => {
      active = false;
    };
  }, [eligibleTenants, onLogout]);

  const value = useMemo(() => {
    if (!tenant) return undefined;
    const grant = pulsoGrantFor(session, tenant.id);
    return grant ? { session, grant, tenant, sites, activeSiteId, setActiveSiteId, logout: onLogout } : undefined;
  }, [session, tenant, sites, activeSiteId, onLogout]);
  if (!ready)
    return (
      <main className="login-shell">
        <LoadingState label="Cargando contexto PULSO…" />
      </main>
    );
  if (!value)
    return (
      <StatusPage code="403" title="Sin grant PULSO">
        Tu sesión no autoriza ningún tenant para este producto.
      </StatusPage>
    );
  return (
    <ConsoleContext.Provider value={value}>
      <Routes>
        <Route path="/" element={<Navigate to="/operacion" replace />} />
        <Route path="/operacion" element={<OperationPage />} />
        <Route path="/conversaciones" element={<ConversationsPage />} />
        <Route path="/agenda" element={<AgendaPage />} />
        <Route path="/rpa" element={<RpaPage />} />
        <Route path="/campanas" element={<CampaignsPage />} />
        <Route path="/bi" element={<BiPage />} />
        <Route path="/configuracion" element={<ConfigPage />} />
        <Route
          path="*"
          element={
            <StatusPage code="404" title="Ruta inexistente">
              Esta consola solo publica flujos de PULSO IRIS.
            </StatusPage>
          }
        />
      </Routes>
    </ConsoleContext.Provider>
  );
}
