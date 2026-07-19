import { LayoutDashboard, LogOut, Orbit } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useNovaConsole } from "../lib/context.js";

export function NovaShell({
  title,
  subtitle,
  actions,
  children
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { session, tenant, tenants, selectTenant, logout } = useNovaConsole();

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido
      </a>
      <aside className="sidebar" aria-label="Navegación NOVA">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            <Orbit size={23} />
          </span>
          <span>
            <strong>NOVA</strong>
            <small>Consola operativa</small>
          </span>
        </div>
        <nav className="sidebar-nav" aria-label="Secciones principales">
          <NavLink className={({ isActive }) => `nav-item${isActive ? " active" : ""}`} end to="/">
            <LayoutDashboard size={18} aria-hidden="true" />
            Operación
          </NavLink>
        </nav>
        <div className="sidebar-footer">
          <span className="status-dot" aria-hidden="true" />
          <span>
            Celda disponible
            <small>{tenant.displayName}</small>
          </span>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div>
            <h1>{title}</h1>
            {subtitle ? <p className="topbar-subtitle">{subtitle}</p> : null}
          </div>
          <div className="topbar-actions">
            {actions}
            {tenants.length > 1 ? (
              <label className="tenant-picker">
                <span className="sr-only">Tenant activo</span>
                <select
                  className="input select-compact"
                  value={tenant.id}
                  onChange={(event) => selectTenant(event.target.value)}
                >
                  {tenants.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.displayName}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <span className="operator-chip" title={session.operator.email}>
              {session.operator.displayName}
            </span>
            <button className="icon-btn" type="button" onClick={logout} aria-label="Cerrar sesión">
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="content" id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
