import { Eye } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { AuthSession } from "@hyperion/contracts";
import { login } from "../lib/api.js";
import { saveSession, type StoredSession } from "../lib/session.js";

export function Login({ onLogin }: { onLogin: (session: StoredSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      const session = (await login(email, password)) as unknown as AuthSession;
      onLogin(saveSession(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : "No fue posible iniciar sesion");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <div className="brand">
          <Eye size={22} aria-hidden="true" />
          <span>PULSO IRIS</span>
        </div>
        <div>
          <div className="login-title">Consola operativa</div>
          <p className="login-copy">Atencion y agendamiento con IA para CEDCO. Ingresa con tu cuenta de operador.</p>
        </div>

        <label className="login-field">
          Correo
          <input
            className="input"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="login-field">
          Contrasena
          <input
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            minLength={8}
            required
          />
        </label>

        {error ? (
          <p className="login-error" role="alert">
            {error}
          </p>
        ) : null}

        <button className="btn btn-primary" type="submit" disabled={submitting}>
          {submitting ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </main>
  );
}
