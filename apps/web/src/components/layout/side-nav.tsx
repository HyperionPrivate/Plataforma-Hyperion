"use client";

import { useEffect, useState } from "react";
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
  Menu,
  X,
  PhoneCall,
  Upload,
  Plus,
} from "lucide-react";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/campanas", label: "Campañas", icon: Megaphone },
  { href: "/conversaciones", label: "Conversaciones", icon: MessagesSquare },
  { href: "/revision-post-llamada", label: "Revisión post-llamada", icon: PhoneCall },
  { href: "/crm", label: "CRM", icon: Kanban },
  { href: "/handoff", label: "Handoff", icon: ArrowLeftRight },
  { href: "/segmentacion", label: "Segmentación", icon: PieChart },
  { href: "/importar", label: "Importar", icon: Upload },
  { href: "/reportes", label: "Reportes", icon: FileBarChart },
  { href: "/laboratorio", label: "Laboratorio", icon: FlaskConical },
  { href: "/configuracion", label: "Configuración", icon: Settings },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-1 flex-col gap-0.5 px-3">
      <Link
        href="/campanas/nueva"
        onClick={onNavigate}
        className="mb-2 inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--accent)] px-3 py-2.5 text-sm font-medium text-[#0A0F0D] shadow-[0_0_12px_rgba(52,211,153,0.15)] transition hover:brightness-110"
      >
        <Plus className="size-4" strokeWidth={2} />
        Nueva campaña
      </Link>
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = pathname === href || pathname.startsWith(href + "/");
        return (
          <Link
            key={href}
            href={href}
            onClick={onNavigate}
            className={cn(
              "relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
              active
                ? "bg-[var(--accent-dim)] text-[var(--accent)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-0.5 before:rounded-full before:bg-[var(--accent)]"
                : "text-[var(--muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text)]",
            )}
            aria-current={active ? "page" : undefined}
          >
            <Icon className="size-[18px] shrink-0" strokeWidth={1.75} />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export function SideNav() {
  return (
    <aside
      className="flex h-screen w-[var(--sidebar-width)] shrink-0 flex-col border-r border-[var(--border)] bg-[var(--bg)]"
      aria-label="Navegación principal"
    >
      <div className="flex items-center gap-2 px-5 py-5">
        <span className="flex size-8 items-center justify-center rounded-full border border-[var(--accent)]/40 text-[var(--accent)]">
          <span className="size-3 rounded-full bg-[var(--accent)] shadow-[0_0_12px_var(--accent)]" />
        </span>
        <div className="min-w-0">
          <span className="block text-lg font-semibold tracking-wide">PULSO</span>
          <span className="block text-[10px] uppercase tracking-wider text-[var(--muted)]">
            Coopfuturo
          </span>
        </div>
      </div>
      <NavLinks />
      <div className="border-t border-[var(--border)] p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--accent-dim)] text-xs font-semibold text-[var(--accent)]">
            AC
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">Admin Coopfuturo</p>
            <p className="truncate text-xs text-[var(--muted)]">Operaciones</p>
          </div>
        </div>
      </div>
    </aside>
  );
}

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-40 flex items-center gap-3 border-b border-[var(--border)] bg-[var(--bg)]/95 px-4 py-3 backdrop-blur md:hidden">
        <button
          type="button"
          aria-label={open ? "Cerrar menú" : "Abrir menú"}
          onClick={() => setOpen((v) => !v)}
          className="rounded-lg border border-[var(--border)] p-2 text-[var(--text)]"
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
        </button>
        <span className="text-sm font-semibold tracking-wide">PULSO</span>
      </header>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/60"
            aria-label="Cerrar menú"
            onClick={() => setOpen(false)}
          />
          <aside className="relative flex h-full w-[min(100%,280px)] flex-col border-r border-[var(--border)] bg-[var(--bg)]">
            <div className="flex items-center justify-between px-4 py-4">
              <span className="font-semibold">PULSO</span>
              <button type="button" aria-label="Cerrar" onClick={() => setOpen(false)}>
                <X className="size-5" />
              </button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      ) : null}
    </>
  );
}
