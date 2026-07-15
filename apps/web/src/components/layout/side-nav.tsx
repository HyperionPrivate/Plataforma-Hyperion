"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Megaphone,
  MessagesSquare,
  Kanban,
  ArrowLeftRight,
  PieChart,
  FileBarChart,
  Settings,
  FlaskConical,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campanas", label: "Campañas", icon: Megaphone },
  { href: "/conversaciones", label: "Conversaciones", icon: MessagesSquare },
  { href: "/crm", label: "CRM", icon: Kanban },
  { href: "/handoff", label: "Handoff", icon: ArrowLeftRight },
  { href: "/segmentacion", label: "Segmentación", icon: PieChart },
  { href: "/reportes", label: "Reportes", icon: FileBarChart },
  { href: "/laboratorio", label: "Laboratorio", icon: FlaskConical },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

export function SideNav() {
  const pathname = usePathname();

  return (
    <aside
      className="flex h-screen w-[var(--sidebar-width)] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg)]"
      aria-label="Navegación principal"
    >
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="flex size-8 items-center justify-center rounded-full border border-[var(--accent)]/40 text-[var(--accent)]">
          <span className="size-3 rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent)]" />
        </span>
        <span className="text-lg font-semibold tracking-wide">PULSO</span>
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 px-3">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-[var(--accent-dim)] text-[var(--accent)]"
                  : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]"
              )}
              aria-current={active ? "page" : undefined}
            >
              <Icon className="size-[18px]" strokeWidth={1.75} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-[var(--border)] p-4">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-full bg-[var(--accent-dim)] text-xs font-semibold text-[var(--accent)]">
            AC
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">Admin Coopfuturo</p>
            <p className="truncate text-xs text-[var(--muted)]">Administrador</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
