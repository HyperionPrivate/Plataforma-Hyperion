import { Activity, AlertCircle, CheckCircle2, Database, GitBranch, RefreshCw, Server, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  productModules,
  serviceCatalog,
  type HealthStatus,
  type PlatformCatalog,
  type PlatformHealth,
  type ResponseEnvelope,
  type ServiceHealth
} from "@hyperion/contracts";

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080";

interface LoadState {
  catalog: PlatformCatalog;
  health?: PlatformHealth;
  loading: boolean;
  error?: string;
}

export function App() {
  const [state, setState] = useState<LoadState>({
    catalog: {
      services: serviceCatalog,
      productModules
    },
    loading: true
  });

  const refresh = useCallback(async (background = false) => {
    if (!background) {
      setState((current) => ({ ...current, loading: true, error: undefined }));
    }

    try {
      const [catalogEnvelope, health] = await Promise.all([
        readJson<ResponseEnvelope<PlatformCatalog>>(`${apiBaseUrl}/v1/platform/catalog`),
        readJson<PlatformHealth>(`${apiBaseUrl}/v1/platform/health`)
      ]);

      setState({
        catalog: catalogEnvelope.data,
        health,
        loading: false
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }, []);

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
          <button className="icon-button" type="button" onClick={() => void refresh()} aria-label="Actualizar estado">
            <RefreshCw size={18} aria-hidden="true" className={state.loading ? "spin" : undefined} />
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

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}
