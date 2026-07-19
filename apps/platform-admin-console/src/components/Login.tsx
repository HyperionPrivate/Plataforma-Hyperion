import { Eye } from "lucide-react";
import { useState, type FormEvent } from "react";
import { login, type AdminSession } from "../lib/session.js";

export function Login({ onLogin }: { onLogin: (session: AdminSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      onLogin(await login(email, password));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No fue posible iniciar sesión");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="login-shell" id="main-content">
      <form className="login-card" onSubmit={submit}>
        <div className="brand">
          <Eye size={22} aria-hidden="true" /> Hyperion
        </div>
        <div>
          <h1>Administración de plataforma</h1>
          <p>Acceso neutral para identidades, tenants, grants y catálogo.</p>
        </div>
        <label>
          Correo
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </label>
        <label>
          Contraseña
          <input
            type="password"
            autoComplete="current-password"
            minLength={8}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </label>
        {error ? (
          <p className="alert" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" disabled={submitting}>
          {submitting ? "Ingresando…" : "Ingresar"}
        </button>
      </form>
    </main>
  );
}
