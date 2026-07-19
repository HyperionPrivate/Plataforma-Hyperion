import { LogOut } from "lucide-react";
import type { ReactNode } from "react";
import { useLumenContext } from "../lib/context.js";

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
  const { session, tenant, facilities, activeFacilityId, setActiveFacilityId, logout } = useLumenContext();

  return (
    <div className={`app${className ? ` ${className}` : ""}`}>
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
              value={activeFacilityId}
              onChange={(event) => setActiveFacilityId(event.target.value)}
              aria-label="Seleccionar sede clínica"
              disabled={facilities.length === 0}
            >
              <option value="all">Todas las sedes</option>
              {facilities.map((facility) => (
                <option key={facility.id} value={facility.id}>
                  {facility.name}
                </option>
              ))}
            </select>
            <span className="chip" title={tenant.displayName}>
              {session.operator.displayName}
            </span>
            <button className="icon-btn" type="button" onClick={logout} aria-label="Cerrar sesión">
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}
