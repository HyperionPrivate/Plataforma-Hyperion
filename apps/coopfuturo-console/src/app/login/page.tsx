"use client";

import { FormEvent, Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { pilotCoreBaseUrl, setAccessToken } from "@/lib/auth";

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
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = params.get("next") || "/dashboard";
  const reason = params.get("reason");
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

  async function onPasswordLogin(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Correo y contraseña son obligatorios.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${pilotCoreBaseUrl()}/auth/login`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        token?: string;
        expiresAt?: string;
        error?: string;
        data?: { token?: string; expiresAt?: string };
      };
      const access = body.token ?? body.data?.token;
      const expiresAt = body.expiresAt ?? body.data?.expiresAt;
      if (!res.ok || !access) {
        setError(body.error || "Credenciales inválidas");
        return;
      }
      setAccessToken(access, expiresAt);
      router.replace(next.startsWith("/") ? next : "/dashboard");
    } catch {
      setError("No se pudo iniciar sesión. Revisa la conexión.");
    } finally {
      setBusy(false);
    }
  }

  function onTokenSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Pega un access token emitido por Hyperion (/v1/auth/login).");
      return;
    }
    setAccessToken(trimmed);
    router.replace(next.startsWith("/") ? next : "/dashboard");
  }

  return (
    <div className="w-full max-w-lg space-y-6 border border-[var(--border)] bg-[var(--surface)] p-8">
      <div className="space-y-2">
        <p className="text-xs tracking-[0.25em] text-[var(--muted)]">PULSO</p>
        <h1 className="text-2xl font-semibold">Acceso autenticado</h1>
        <p className="text-sm text-[var(--muted)]">
          Inicia sesión con tu usuario Hyperion. Si la sesión caduca, Lab e import CSV responden 401
          hasta que vuelvas a entrar.
        </p>
        {reason === "expired" ? (
          <p className="text-sm text-amber-300">Tu sesión expiró. Vuelve a iniciar sesión.</p>
        ) : null}
      </div>

      {authorizeUrl ? (
        <a
          href={authorizeUrl}
          className="block w-full bg-[var(--accent)] px-4 py-3 text-center text-sm font-medium text-black"
        >
          Continuar con IdP
        </a>
      ) : null}

      <form onSubmit={onPasswordLogin} className="space-y-4">
        <label className="block space-y-2 text-sm">
          <span className="text-[var(--muted)]">Correo</span>
          <input
            type="email"
            className="w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-sm"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </label>
        <label className="block space-y-2 text-sm">
          <span className="text-[var(--muted)]">Contraseña</span>
          <input
            type="password"
            className="w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-sm"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error ? <p className="text-sm text-red-400">{error}</p> : null}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-[var(--accent)] px-4 py-3 text-sm font-medium text-black disabled:opacity-60"
        >
          {busy ? "Entrando…" : "Entrar"}
        </button>
      </form>

      <details className="space-y-3 text-sm">
        <summary className="cursor-pointer text-[var(--muted)]">Pegar token manual (avanzado)</summary>
        <form onSubmit={onTokenSubmit} className="space-y-3 pt-2">
          <textarea
            className="min-h-24 w-full border border-[var(--border)] bg-[var(--bg)] p-3 font-mono text-xs"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="token de POST /v1/auth/login"
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" className="w-full border border-[var(--border)] px-4 py-3 text-sm font-medium">
            Continuar con token
          </button>
        </form>
      </details>
    </div>
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
