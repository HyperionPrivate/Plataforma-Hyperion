"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { setAccessToken } from "@/lib/auth";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Pega un access token JWT (Bearer) emitido por tu IdP.");
      return;
    }
    setAccessToken(trimmed);
    const next = params.get("next") || "/dashboard";
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
          Obtén un access token RS256 de tu IdP (issuer/audience configurados en el backend) y
          pégalo aquí. La UI lo envía como Bearer hacia{" "}
          <code className="text-[var(--text)]">/pilot-core</code>.
        </p>
      </div>
      <label className="block space-y-2 text-sm">
        <span className="text-[var(--muted)]">Access token</span>
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
        className="w-full bg-[var(--accent)] px-4 py-3 text-sm font-medium text-black"
      >
        Continuar
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
