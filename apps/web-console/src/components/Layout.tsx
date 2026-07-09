import { Activity, BarChart3, Bot, CalendarDays, Eye, LogOut, MessagesSquare, Megaphone, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useConsole } from "../lib/context.js";

const NAV = [
  { to: "/operacion", label: "Operacion en vivo", icon: Activity },
  { to: "/conversaciones", label: "Conversaciones", icon: MessagesSquare },
  { to: "/agenda", label: "Agenda", icon: CalendarDays },
  { to: "/rpa", label: "Workers RPA", icon: Bot },
  { to: "/campanas", label: "Campanas", icon: Megaphone },
  { to: "/bi", label: "BI y Reportes", icon: BarChart3 },
  { to: "/configuracion", label: "Configuracion", icon: Settings }
];

export function Layout({
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
  const { session, tenant, sites, activeSiteId, setActiveSiteId, logout } = useConsole();

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Eye size={22} aria-hidden="true" />
          PULSO IRIS
        </div>
        <nav className="col" style={{ gap: 4 }}>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
              <item.icon size={18} aria-hidden="true" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="dot" />
          <div className="col">
            <span>Sistema operativo</span>
            <span className="tiny muted">{tenant.displayName} - SOFIA activa</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="col">
            <h1>{title}</h1>
            {subtitle ? <span className="topbar-sub">{subtitle}</span> : null}
          </div>
          <div className="topbar-actions">
            {actions}
            <select
              className="select"
              value={activeSiteId}
              onChange={(event) => setActiveSiteId(event.target.value)}
              aria-label="Seleccionar sede"
            >
              <option value="all">Todas las sedes</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
            <span className="chip">{session.operator.displayName}</span>
            <button className="icon-btn" type="button" onClick={logout} aria-label="Cerrar sesion">
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
