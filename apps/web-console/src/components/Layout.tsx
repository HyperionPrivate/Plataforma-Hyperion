import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  Eye,
  LogOut,
  MessagesSquare,
  Megaphone,
  Settings,
  Stethoscope
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useConsole } from "../lib/context.js";
import { can, type Capability } from "../lib/rbac.js";

const NAV = [
  { to: "/operacion", label: "Operacion en vivo", icon: Activity, capability: "view:operation" },
  { to: "/conversaciones", label: "Conversaciones", icon: MessagesSquare, capability: "view:conversations" },
  { to: "/agenda", label: "Agenda", icon: CalendarDays, capability: "view:agenda" },
  { to: "/lumen", label: "LUMEN clinico", icon: Stethoscope, capability: "view:lumen" },
  { to: "/rpa", label: "Workers RPA", icon: Bot, capability: "view:rpa" },
  { to: "/campanas", label: "Campanas", icon: Megaphone, capability: "view:campaigns" },
  { to: "/bi", label: "BI y Reportes", icon: BarChart3, capability: "view:bi" },
  { to: "/configuracion", label: "Configuracion", icon: Settings, capability: "view:config" }
] satisfies Array<{ to: string; label: string; icon: typeof Activity; capability: Capability }>;

export function Layout({
  title,
  subtitle,
  actions,
  className,
  children
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  const { session, tenant, sites, activeSiteId, setActiveSiteId, logout } = useConsole();

  return (
    <div className={`app${className ? ` ${className}` : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <Eye size={22} aria-hidden="true" />
          HYPERION
        </div>
        <nav className="col" style={{ gap: 4 }}>
          {NAV.filter((item) => can(session.operator.role, item.capability)).map((item) => (
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
