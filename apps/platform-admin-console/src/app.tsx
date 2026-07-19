import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { Login } from "./components/Login.js";
import { AdminContext } from "./lib/context.js";
import { canAdministerPlatform, logout, readSession, type AdminSession } from "./lib/session.js";
import { isPlatformAdminRoute } from "./lib/routes.js";
import { CatalogPage, ForbiddenPage, GrantsPage, NotFoundPage, OperatorsPage, TenantsPage } from "./pages.js";

export function App() {
  const [session, setSession] = useState<AdminSession>();
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
  const context = useMemo(() => (session ? { session, logout: onLogout } : undefined), [session, onLogout]);

  if (!isPlatformAdminRoute(window.location.pathname)) return <NotFoundPage />;
  if (!ready)
    return (
      <main className="centered" id="main-content" aria-live="polite">
        Conectando con la plataforma…
      </main>
    );
  if (!session) return <Login onLogin={setSession} />;
  if (!canAdministerPlatform(session)) return <ForbiddenPage />;

  return (
    <AdminContext.Provider value={context!}>
      <Routes>
        <Route path="/" element={<Navigate to="/operators" replace />} />
        <Route path="/operators" element={<OperatorsPage />} />
        <Route path="/tenants" element={<TenantsPage />} />
        <Route path="/grants" element={<GrantsPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AdminContext.Provider>
  );
}
