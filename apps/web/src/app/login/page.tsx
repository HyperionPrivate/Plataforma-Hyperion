"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setAccessToken } from "@/lib/auth";

function oidcAuthorizeUrl(nextPath: string): string | null {
  const base = (process.env.NEXT_PUBLIC_OIDC_AUTHORIZE_URL || "").trim();
  if (!base) return null;
  try {
    const url = new URL(
      base,
      typeof window !== "undefined" ? window.location.origin : "http://localhost",
    );
    if (!url.searchParams.get("redirect_uri")) {
      url.searchParams.set(
        "redirect_uri",
        typeof window !== "undefined"
          ? `${window.location.origin}/login`
          : "http://localhost:3000/login",
      );
    }
    if (!url.searchParams.get("state")) {
      url.searchParams.set("state", nextPath.startsWith("/") ? nextPath : "/dashboard");
    }
    return url.toString();
  } catch {
    return null;
  }
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const next = params.get("next") || "/dashboard";
  const authorizeUrl = useMemo(() => oidcAuthorizeUrl(next), [next]);

  // AUD2-005: accept implicit/token redirect fragment from IdP when configured.
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (!hash) return;
    const qs = new URLSearchParams(hash);
    const access = qs.get("access_token");
    if (!access) return;
    setAccessToken(access);
    const state = params.get("state") || qs.get("state") || next;
    router.replace(state.startsWith("/") ? state : "/dashboard");
  }, [params, next, router]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Pega un access token JWT (Bearer) emitido por tu IdP.");
      return;
    }
    setAccessToken(trimmed);
    router.replace(next.startsWith("/") ? next : "/dashboard");
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-lg space-y-6 border border-[var(--border)] bg-[var(--surface)] p-8"
    >
      <div className="space-y-2">
        <p className="text-xs tracking-[0.25em] text-[var(--muted)]">PULSO</p>
        <h1 className="text-2xl font-semibold">Acceso autenticado</h1>
        <p className="text-sm text-[var(--muted)]">
          Preferido: iniciar sesión con el IdP (OIDC). Alternativa de laboratorio: pegar un access
          token RS256. La UI lo envía como Bearer hacia{" "}
          <code className="text-[var(--text)]">/pilot-core</code>.
        </p>
      </div>

      {authorizeUrl ? (
        <a
          href={authorizeUrl}
          className="block w-full bg-[var(--accent)] px-4 py-3 text-center text-sm font-medium text-black"
        >
          Continuar con IdP
        </a>
      ) : (
        <p className="text-xs text-[var(--muted)]">
          Configura <code>NEXT_PUBLIC_OIDC_AUTHORIZE_URL</code> para el redirect OIDC. Mientras
          tanto puedes pegar un JWT de prueba.
        </p>
      )}

      <label className="block space-y-2 text-sm">
        <span className="text-[var(--muted)]">Access token (laboratorio)</span>
        <textarea
          className="min-h-32 w-full border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9..."
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {error ? <p className="text-sm text-red-400">{error}</p> : null}
      <button
        type="submit"
        className="w-full border border-[var(--border)] px-4 py-3 text-sm font-medium"
      >
        Continuar con token
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] px-4 text-[var(--text)]">
      <Suspense fallback={<p className="text-[var(--muted)]">Cargando…</p>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
