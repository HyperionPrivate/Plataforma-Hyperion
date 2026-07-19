import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Route, Routes } from "react-router-dom";
import { Login } from "./components/Login.js";
import { ForbiddenPage, NotFoundPage } from "./components/StatusPage.js";
import { LoadingState } from "./components/ui.js";
import { api, currentSession, logout, SessionExpiredError } from "./lib/api.js";
import { NovaConsoleContext, useNovaConsole, type TenantInfo } from "./lib/context.js";
import { NOVA_CONSOLE_PATH } from "./lib/router.js";
import { authorizedNovaTenantIds, findNovaGrant, novaGrantAllows, type AccessPrincipal } from "./lib/session.js";
import { NovaPage } from "./pages/NovaPage.js";

interface TenantRow {
  id: string;
  display_name?: string;
  displayName?: string;
}

type AuthState =
  | { kind: "loading" }
  | { kind: "anonymous" }
  | { kind: "authenticated"; session: AccessPrincipal }
  | { kind: "error"; message: string };

export function App() {
  return (
    <Routes>
      <Route path={NOVA_CONSOLE_PATH} element={<AuthenticatedConsole />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

function AuthenticatedConsole() {
  const [auth, setAuth] = useState<AuthState>({ kind: "loading" });

  const reloadSession = useCallback(async () => {
    setAuth({ kind: "loading" });
    try {
      setAuth({ kind: "authenticated", session: await currentSession() });
    } catch (cause) {
      if (cause instanceof SessionExpiredError) {
        setAuth({ kind: "anonymous" });
        return;
      }
      setAuth({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, []);

  useEffect(() => {
    void reloadSession();
  }, [reloadSession]);

  const handleLogout = useCallback(async () => {
    await logout();
    setAuth({ kind: "anonymous" });
  }, []);

  if (auth.kind === "loading") {
    return (
      <main className="status-page" id="main-content">
        <LoadingState label="Validando sesión NOVA…" />
      </main>
    );
  }
  if (auth.kind === "anonymous") return <Login onLogin={(session) => setAuth({ kind: "authenticated", session })} />;
  if (auth.kind === "error") {
    return (
      <main className="status-page" id="main-content">
        <div className="status-card" role="alert">
          <h1>No fue posible validar la sesión</h1>
          <p>{auth.message}</p>
          <button className="btn btn-primary" type="button" onClick={() => void reloadSession()}>
            Reintentar
          </button>
        </div>
      </main>
    );
  }

  return <ConsoleBootstrap session={auth.session} onLogout={() => void handleLogout()} />;
}

function ConsoleBootstrap({ session, onLogout }: { session: AccessPrincipal; onLogout: () => void }) {
  const allowedTenantIds = useMemo(() => authorizedNovaTenantIds(session), [session]);
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [tenantId, setTenantId] = useState(allowedTenantIds[0]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (allowedTenantIds.length === 0) {
        setLoading(false);
        return;
      }
      try {
        const rows = await api.get<TenantRow[]>("/v1/tenants");
        const allowed = new Set(allowedTenantIds);
        const named = rows
          .filter((row) => allowed.has(row.id))
          .map((row) => ({
            id: row.id,
            displayName: row.display_name ?? row.displayName ?? row.id
          }));
        const known = new Set(named.map((tenant) => tenant.id));
        const fallback = allowedTenantIds
          .filter((id) => !known.has(id))
          .map((id) => ({ id, displayName: `Tenant ${id.slice(0, 8)}` }));
        if (!cancelled) setTenants([...named, ...fallback]);
      } catch (cause) {
        if (!cancelled) {
          setTenants(allowedTenantIds.map((id) => ({ id, displayName: `Tenant ${id.slice(0, 8)}` })));
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [allowedTenantIds]);

  useEffect(() => {
    if (!tenantId || !allowedTenantIds.includes(tenantId)) setTenantId(allowedTenantIds[0]);
  }, [allowedTenantIds, tenantId]);

  if (loading) {
    return (
      <main className="status-page" id="main-content">
        <LoadingState label="Cargando grants y tenants…" />
      </main>
    );
  }

  const tenant = tenants.find((item) => item.id === tenantId);
  const grant = tenant ? findNovaGrant(session, tenant.id) : undefined;
  if (!tenant || !grant || !novaGrantAllows(grant, "nova:read")) return <ForbiddenPage onLogout={onLogout} />;

  const context = {
    session,
    tenant,
    tenants,
    grant,
    selectTenant: setTenantId,
    logout: onLogout
  };

  return (
    <NovaConsoleContext.Provider value={context}>
      {error ? <div className="bootstrap-warning">Catálogo de tenants no disponible: {error}</div> : null}
      <RequireNovaGrant>
        <NovaPage />
      </RequireNovaGrant>
    </NovaConsoleContext.Provider>
  );
}

function RequireNovaGrant({ children }: { children: ReactNode }) {
  const context = useNovaConsole();
  if (!novaGrantAllows(context.grant, "nova:read")) return <ForbiddenPage onLogout={context.logout} />;
  return children;
}
