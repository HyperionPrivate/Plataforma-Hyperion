"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  hasUsableSession,
  logoutSession,
  requireAuthEnabled,
} from "@/lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(!requireAuthEnabled());

  useEffect(() => {
    let active = true;
    if (!requireAuthEnabled() || pathname === "/login") {
      setReady(true);
      return () => {
        active = false;
      };
    }

    setReady(false);
    void hasUsableSession().then((usable) => {
      if (!active) return;
      if (!usable) {
        const next = pathname || "/dashboard";
        router.replace(`/login?next=${encodeURIComponent(next)}&reason=expired`);
        return;
      }
      setReady(true);
    });

    return () => {
      active = false;
    };
  }, [pathname, router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        Comprobando sesión NOVA…
      </div>
    );
  }

  return <>{children}</>;
}

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  if (!requireAuthEnabled()) return null;
  return (
    <button
      type="button"
      disabled={busy}
      title={failed ? "No se pudo cerrar la sesión. Intenta de nuevo." : undefined}
      className="text-[10px] tracking-[0.15em] text-[var(--muted)] underline-offset-2 hover:underline disabled:opacity-60"
      onClick={async () => {
        setBusy(true);
        setFailed(false);
        try {
          await logoutSession();
          router.replace("/login");
          router.refresh();
        } catch {
          setFailed(true);
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? "Cerrando…" : failed ? "Reintentar cierre" : "Cerrar sesión"}
    </button>
  );
}
