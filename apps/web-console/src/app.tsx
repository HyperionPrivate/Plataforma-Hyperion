import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import type { PulsoIrisSite } from "@hyperion/contracts";
import { Login } from "./components/Login.js";
import { LoadingState } from "./components/ui.js";
import { api, apiBaseUrl, SessionExpiredError } from "./lib/api.js";
import { ConsoleContext, tenantPath, type TenantInfo } from "./lib/context.js";
import { clearSession, loadSession, type StoredSession } from "./lib/session.js";
import { AgendaPage } from "./pages/AgendaPage.js";
import { BiPage } from "./pages/BiPage.js";
import { CampaignsPage } from "./pages/CampaignsPage.js";
import { ConfigPage } from "./pages/ConfigPage.js";
import { ConversationsPage } from "./pages/ConversationsPage.js";
import { NovaPage } from "./pages/NovaPage.js";
import { OperationPage } from "./pages/OperationPage.js";
import { RpaPage } from "./pages/RpaPage.js";

const LumenPage = lazy(() => import("./pages/LumenPage.js").then((module) => ({ default: module.LumenPage })));

interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
}

export function App() {
  const [session, setSession] = useState<StoredSession | undefined>(() => loadSession());

  const logout = useCallback(() => {
    const current = loadSession();
    if (current) {
      void fetch(`${apiBaseUrl}/v1/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${current.token}` }
      }).catch(() => undefined);
    }
    clearSession();
    setSession(undefined);
  }, []);

  if (!session) {
    return <Login onLogin={setSession} />;
  }

  return <ConsoleShell session={session} onLogout={logout} />;
}

function ConsoleShell({ session, onLogout }: { session: StoredSession; onLogout: () => void }) {
  const [tenant, setTenant] = useState<TenantInfo>();
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [sites, setSites] = useState<PulsoIrisSite[]>([]);
  const [activeSiteId, setActiveSiteId] = useState<string | "all">("all");
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const tenants = await api.get<TenantRow[]>("/v1/tenants");
        // Prefer Coopfuturo (NOVA/LIWA) when present; otherwise CEDCO / first available.
        const selected =
          tenants.find((row) => row.slug === "coopfuturo") ??
          tenants.find((row) => row.slug === "cedco") ??
          tenants[0];
        if (!selected) {
          setError("No hay tenants disponibles para este operador.");
          setReady(true);
          return;
        }

        const info: TenantInfo = { id: selected.id, slug: selected.slug, displayName: selected.display_name };
        let siteList: PulsoIrisSite[] = [];
        try {
          siteList = await api.get<PulsoIrisSite[]>(tenantPath(selected.id, "config/sites"));
        } catch {
          siteList = [];
        }

        if (!cancelled) {
          setTenant(info);
          setTenants(tenants.map((row) => ({ id: row.id, slug: row.slug, displayName: row.display_name })));
          setSites(siteList);
          setReady(true);
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof SessionExpiredError) {
          onLogout();
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
        setReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [onLogout]);

  const contextValue = useMemo(() => {
    if (!tenant) return undefined;
    return { session, tenant, tenants, sites, activeSiteId, setActiveSiteId, logout: onLogout };
  }, [session, tenant, tenants, sites, activeSiteId, onLogout]);

  if (!ready) {
    return (
      <main className="login-shell">
        <LoadingState label="Conectando con la plataforma..." />
      </main>
    );
  }

  if (!contextValue) {
    return (
      <main className="login-shell">
        <div className="login-card">
          <div className="login-title">No se pudo cargar la consola</div>
          <p className="login-copy">{error ?? "Sin tenant disponible."}</p>
          <button className="btn btn-primary" type="button" onClick={onLogout}>
            Volver a ingresar
          </button>
        </div>
      </main>
    );
  }

  return (
    <ConsoleContext.Provider value={contextValue}>
      <Routes>
        <Route path="/" element={<Navigate to="/operacion" replace />} />
        <Route path="/operacion" element={<OperationPage />} />
        <Route path="/conversaciones" element={<ConversationsPage />} />
        <Route path="/agenda" element={<AgendaPage />} />
        <Route
          path="/lumen/*"
          element={
            <Suspense
              fallback={
                <main className="login-shell">
                  <LoadingState label="Cargando LUMEN..." />
                </main>
              }
            >
              <LumenPage />
            </Suspense>
          }
        />
        <Route path="/nova" element={<NovaPage />} />
        <Route path="/rpa" element={<RpaPage />} />
        <Route path="/campanas" element={<CampaignsPage />} />
        <Route path="/bi" element={<BiPage />} />
        <Route path="/configuracion" element={<ConfigPage />} />
        <Route path="*" element={<Navigate to="/operacion" replace />} />
      </Routes>
    </ConsoleContext.Provider>
  );
}
