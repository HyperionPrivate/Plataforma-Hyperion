"use client";

import { FormEvent, Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { pilotCoreBaseUrl } from "@/lib/auth";
import { safeNextPath } from "@/lib/safe-next-path";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = safeNextPath(params.get("next"));
  const reason = params.get("reason");

  async function onPasswordLogin(event: FormEvent) {
    event.preventDefault();
    setError(null);
    const trimmedEmail = email.trim();
    if (!trimmedEmail || !password) {
      setError("Correo y contraseña son obligatorios.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`${pilotCoreBaseUrl()}/auth/login`, {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ email: trimmedEmail, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        data?: { error?: string };
      };
      if (!response.ok) {
        setError(payload.error ?? payload.data?.error ?? "Credenciales inválidas");
        return;
      }
      setPassword("");
      router.replace(next);
      router.refresh();
    } catch {
      setError("No se pudo iniciar sesión. Revisa la conexión.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-lg space-y-6 border border-[var(--border)] bg-[var(--surface)] p-8">
      <div className="space-y-2">
        <p className="text-xs tracking-[0.25em] text-[var(--muted)]">NOVA · COOPFUTURO</p>
        <h1 className="text-2xl font-semibold">Acceso seguro</h1>
        <p className="text-sm text-[var(--muted)]">
          Inicia sesión con tu usuario Hyperion. La sesión queda protegida en una cookie
          aislada de NOVA y nunca se expone al navegador.
        </p>
        {reason === "expired" ? (
          <p className="text-sm text-amber-300">Tu sesión expiró. Vuelve a iniciar sesión.</p>
        ) : null}
      </div>

      <form onSubmit={onPasswordLogin} className="space-y-4">
        <label className="block space-y-2 text-sm">
          <span className="text-[var(--muted)]">Correo</span>
          <input
            type="email"
            className="w-full border border-[var(--border)] bg-[var(--bg)] p-3 text-sm"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
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
            onChange={(event) => setPassword(event.target.value)}
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
