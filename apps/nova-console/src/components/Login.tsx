import { Orbit } from "lucide-react";
import { useState, type FormEvent } from "react";
import { login } from "../lib/api.js";
import type { AccessPrincipal } from "../lib/session.js";

export function Login({ onLogin }: { onLogin: (session: AccessPrincipal) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      onLogin(await login(email, password));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible iniciar sesión");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-shell" id="main-content">
      <form className="login-card" onSubmit={(event) => void handleSubmit(event)}>
        <div className="brand" aria-label="NOVA">
          <span className="brand-mark" aria-hidden="true">
            <Orbit size={24} />
          </span>
          <span>NOVA</span>
        </div>
        <div>
          <h1 className="login-title">Consola operativa</h1>
          <p className="login-copy">Gestiona campañas, conversaciones y seguimiento desde un entorno dedicado.</p>
        </div>

        <label className="login-field" htmlFor="email">
          Correo
        </label>
        <input
          className="input"
          id="email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="username"
          required
        />

        <label className="login-field" htmlFor="password">
          Contraseña
        </label>
        <input
          className="input"
          id="password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          minLength={8}
          required
        />

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Ingresando…" : "Ingresar"}
        </button>
        <p className="login-security">La sesión se mantiene en una cookie segura y no se expone al navegador.</p>
      </form>
    </main>
  );
}
