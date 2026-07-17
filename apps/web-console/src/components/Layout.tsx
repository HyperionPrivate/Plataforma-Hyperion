import {
  Activity,
  BarChart3,
  Bot,
  CalendarDays,
  Eye,
  LogOut,
  MessagesSquare,
  Megaphone,
  PhoneCall,
  Settings,
  Stethoscope
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useConsole } from "../lib/context.js";
import { brandLabel, productEnabled, type ProductScope } from "../lib/product.js";
import { can, type Capability } from "../lib/rbac.js";

const NAV = [
  { to: "/operacion", label: "Operacion en vivo", icon: Activity, capability: "view:operation", product: "pulso" },
  {
    to: "/conversaciones",
    label: "Conversaciones",
    icon: MessagesSquare,
    capability: "view:conversations",
    product: "pulso"
  },
  { to: "/agenda", label: "Agenda", icon: CalendarDays, capability: "view:agenda", product: "pulso" },
  { to: "/lumen", label: "LUMEN clinico", icon: Stethoscope, capability: "view:lumen", product: "lumen" },
  { to: "/nova", label: "NOVA", icon: PhoneCall, capability: "view:nova", product: "nova" },
  { to: "/rpa", label: "Workers RPA", icon: Bot, capability: "view:rpa", product: "pulso" },
  { to: "/campanas", label: "Campanas", icon: Megaphone, capability: "view:campaigns", product: "pulso" },
  { to: "/bi", label: "BI y Reportes", icon: BarChart3, capability: "view:bi", product: "pulso" },
  { to: "/configuracion", label: "Configuracion", icon: Settings, capability: "view:config", product: "pulso" }
] satisfies Array<{
  to: string;
  label: string;
  icon: typeof Activity;
  capability: Capability;
  product: ProductScope;
}>;

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
          {brandLabel}
        </div>
        <nav className="col" style={{ gap: 4 }}>
          {NAV.filter((item) => productEnabled(item.product) && can(session.operator.role, item.capability)).map(
            (item) => (
              <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-item${isActive ? " active" : ""}`}>
                <item.icon size={18} aria-hidden="true" />
                {item.label}
              </NavLink>
            )
          )}
        </nav>
        <div className="sidebar-footer">
          <span className="dot" />
          <div className="col">
            <span>Sistema operativo</span>
            <span className="tiny muted">
              {tenant.displayName}
              {productEnabled("pulso") ? " - SOFIA activa" : ""}
            </span>
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
            {productEnabled("pulso") ? (
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
            ) : null}
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
