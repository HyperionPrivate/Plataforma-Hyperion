import { BookOpen, Building2, KeyRound, LogOut, Users } from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useAdmin } from "../lib/context.js";

const NAV = [
  { to: "/operators", label: "Usuarios", icon: Users },
  { to: "/tenants", label: "Tenants", icon: Building2 },
  { to: "/grants", label: "Grants", icon: KeyRound },
  { to: "/catalog", label: "Catálogo", icon: BookOpen }
] as const;

export function Layout({ title, children }: { title: string; children: ReactNode }) {
  const { session, logout } = useAdmin();
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Saltar al contenido
      </a>
      <aside>
        <div className="brand">
          Hyperion <span>Admin</span>
        </div>
        <nav aria-label="Administración de plataforma">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => (isActive ? "active" : undefined)}>
              <Icon size={18} aria-hidden="true" />
              {label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="workspace">
        <header>
          <div>
            <h1>{title}</h1>
            <p>Plano neutral de control</p>
          </div>
          <div className="operator">
            <span>{session.operator.displayName}</span>
            <button className="icon-button" onClick={logout} aria-label="Cerrar sesión">
              <LogOut size={18} aria-hidden="true" />
            </button>
          </div>
        </header>
        <main id="main-content">{children}</main>
      </div>
    </div>
  );
}
