"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  clearAccessToken,
  hasUsableSession,
  requireAuthEnabled,
} from "@/lib/auth";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [ready, setReady] = useState(!requireAuthEnabled());

  useEffect(() => {
    if (!requireAuthEnabled()) {
      setReady(true);
      return;
    }
    if (pathname === "/login") {
      setReady(true);
      return;
    }
    if (!hasUsableSession()) {
      clearAccessToken();
      router.replace(
        `/login?next=${encodeURIComponent(pathname || "/dashboard")}&reason=expired`,
      );
      return;
    }
    setReady(true);
  }, [pathname, router]);

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--muted)]">
        Comprobando sesión…
      </div>
    );
  }

  return <>{children}</>;
}

export function LogoutButton() {
  const router = useRouter();
  if (!requireAuthEnabled()) return null;
  return (
    <button
      type="button"
      className="text-[10px] tracking-[0.15em] text-[var(--muted)] underline-offset-2 hover:underline"
      onClick={() => {
        clearAccessToken();
        router.push("/login");
      }}
    >
      Cerrar sesión
    </button>
  );
}
