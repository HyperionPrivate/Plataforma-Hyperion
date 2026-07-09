import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Database,
  GitBranch,
  LogOut,
  RefreshCw,
  Server,
  Shield
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  productModules,
  serviceCatalog,
  type AuthSession,
  type HealthStatus,
  type PlatformCatalog,
  type PlatformHealth,
  type ResponseEnvelope,
  type ServiceHealth
} from "@hyperion/contracts";
import { clearSession, loadSession, saveSession, type StoredSession } from "./session.js";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

interface LoadState {
  catalog: PlatformCatalog;
  health?: PlatformHealth;
  loading: boolean;
  error?: string;
}

export function App() {
  const [session, setSession] = useState<StoredSession | undefined>(() => loadSession());

  const handleLogout = useCallback(() => {
    const current = loadSession();
    if (current) {
      void fetch(`${apiBaseUrl}/v1/auth/logout`, {
        method: "POST",
        headers: { authorization: `Bearer ${current.token}` }
      }).catch(() => undefined);
    }
    clearSession();
    setSession(undefined);
  }, []);

  if (!session) {
    return <LoginScreen onLogin={setSession} />;
  }

  return <Dashboard session={session} onSessionExpired={handleLogout} onLogout={handleLogout} />;
}

function LoginScreen({ onLogin }: { onLogin: (session: StoredSession) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);

    try {
      const response = await fetch(`${apiBaseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const payload = (await response.json()) as ResponseEnvelope<AuthSession & { error?: string }>;
      if (!response.ok) {
        setError(payload.data?.error ?? "No fue posible iniciar sesion");
        return;
      }

      onLogin(saveSession(payload.data));
    } catch {
      setError("No hay conexion con la plataforma");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="shell login-shell">
      <form className="login-card" onSubmit={handleSubmit}>
        <p className="eyebrow">Hyperion</p>
        <h1>Control Plane</h1>
        <p className="login-copy">Ingresa con tu cuenta de operador.</p>

        <label className="login-field">
          <span>Correo</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="username"
            required
          />
        </label>

        <label className="login-field">
          <span>Contrasena</span>
          <input
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

        <button className="login-button" type="submit" disabled={submitting}>
          {submitting ? "Ingresando..." : "Ingresar"}
        </button>
      </form>
    </main>
  );
}

function Dashboard({
  session,
  onSessionExpired,
  onLogout
}: {
  session: StoredSession;
  onSessionExpired: () => void;
  onLogout: () => void;
}) {
  const [state, setState] = useState<LoadState>({
    catalog: {
      services: serviceCatalog,
      productModules
    },
    loading: true
  });

  const refresh = useCallback(
    async (background = false) => {
      if (!background) {
        setState((current) => ({ ...current, loading: true, error: undefined }));
      }

      try {
        const [catalogEnvelope, health] = await Promise.all([
          readJson<ResponseEnvelope<PlatformCatalog>>(`${apiBaseUrl}/v1/platform/catalog`, session.token),
          readJson<PlatformHealth>(`${apiBaseUrl}/v1/platform/health`, session.token)
        ]);

        setState({
          catalog: catalogEnvelope.data,
          health,
          loading: false
        });
      } catch (error) {
        if (error instanceof SessionExpiredError) {
          onSessionExpired();
          return;
        }

        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error)
        }));
      }
    },
    [session.token, onSessionExpired]
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh(true);
    }, 15_000);

    return () => window.clearInterval(timer);
  }, [refresh]);

  const serviceHealth = useMemo(() => {
    const entries = new Map<ServiceHealth["service"], ServiceHealth>();
    for (const item of state.health?.services ?? []) {
      entries.set(item.service, item);
    }
    return entries;
  }, [state.health]);

  const totals = useMemo(() => {
    const values = [...serviceHealth.values()];
    return {
      ok: values.filter((item) => item.status === "ok").length,
      degraded: values.filter((item) => item.status === "degraded").length,
      down: values.filter((item) => item.status === "down").length
    };
  }, [serviceHealth]);

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Hyperion</p>
          <h1>Control Plane</h1>
        </div>
        <div className="topbar-actions">
          <div className="api-chip">
            <Server size={16} aria-hidden="true" />
            <span>{apiBaseUrl}</span>
          </div>
          <div className="api-chip">
            <Shield size={16} aria-hidden="true" />
            <span>{session.operator.displayName}</span>
          </div>
          <button className="icon-button" type="button" onClick={() => void refresh()} aria-label="Actualizar estado">
            <RefreshCw size={18} aria-hidden="true" className={state.loading ? "spin" : undefined} />
          </button>
          <button className="icon-button" type="button" onClick={onLogout} aria-label="Cerrar sesion">
            <LogOut size={18} aria-hidden="true" />
          </button>
        </div>
      </header>

      <section className="status-strip" aria-label="Estado de plataforma">
        <StatusMetric
          label="Estado"
          value={formatStatus(state.health?.status)}
          status={state.health?.status ?? "degraded"}
        />
        <StatusMetric label="Operativos" value={String(totals.ok)} status="ok" />
        <StatusMetric label="Degradados" value={String(totals.degraded)} status="degraded" />
        <StatusMetric label="Caidos" value={String(totals.down)} status="down" />
      </section>

      {state.error ? (
        <section className="error-band" role="status">
          <AlertCircle size={18} aria-hidden="true" />
          <span>{state.error}</span>
        </section>
      ) : null}

      <section className="layout-grid">
        <div className="panel">
          <div className="panel-heading">
            <Activity size={18} aria-hidden="true" />
            <h2>Servicios</h2>
          </div>
          <div className="service-grid">
            {state.catalog.services.map((service) => {
              const health = serviceHealth.get(service.name);
              return (
                <article className="service-card" key={service.name}>
                  <div className="service-card-heading">
                    <StatusIcon status={health?.status ?? "degraded"} />
                    <div>
                      <h3>{service.name}</h3>
                      <p>:{service.port}</p>
                    </div>
                  </div>
                  <p className="service-copy">{service.responsibility}</p>
                  <span className={`status-pill ${health?.status ?? "degraded"}`}>{formatStatus(health?.status)}</span>
                </article>
              );
            })}
          </div>
        </div>

        <aside className="side-panel">
          <div className="panel-heading">
            <Shield size={18} aria-hidden="true" />
            <h2>Productos</h2>
          </div>
          <div className="product-list">
            {state.catalog.productModules.map((product) => (
              <div className="product-row" key={product.code}>
                <div>
                  <strong>{product.code}</strong>
                  <span>{product.name}</span>
                </div>
                <span className={`status-pill ${product.status === "active" ? "ok" : "degraded"}`}>
                  {product.status}
                </span>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section className="architecture-band" aria-label="Arquitectura">
        <div className="lane">
          <GitBranch size={20} aria-hidden="true" />
          <h2>Gateway</h2>
          <p>Entrada publica y health agregado.</p>
        </div>
        <div className="lane">
          <Server size={20} aria-hidden="true" />
          <h2>Servicios</h2>
          <p>Dominios separados por responsabilidad.</p>
        </div>
        <div className="lane">
          <Database size={20} aria-hidden="true" />
          <h2>Datos</h2>
          <p>PostgreSQL con esquema platform.</p>
        </div>
      </section>
    </main>
  );
}

function StatusMetric(props: { label: string; value: string; status: HealthStatus }) {
  return (
    <div className={`metric ${props.status}`}>
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function StatusIcon({ status }: { status: HealthStatus }) {
  if (status === "ok") {
    return <CheckCircle2 className="status-icon ok" size={22} aria-hidden="true" />;
  }

  return <AlertCircle className={`status-icon ${status}`} size={22} aria-hidden="true" />;
}

function formatStatus(status?: HealthStatus): string {
  if (status === "ok") {
    return "ok";
  }

  if (status === "down") {
    return "down";
  }

  return "degraded";
}

class SessionExpiredError extends Error {}

async function readJson<T>(url: string, token: string): Promise<T> {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` }
  });

  if (response.status === 401) {
    throw new SessionExpiredError("Sesion expirada");
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}
