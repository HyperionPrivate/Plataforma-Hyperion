import { useCallback, useEffect, useState } from "react";
import { Card, CardHead, EmptyState, LoadingState } from "../../components/ui.js";
import { api } from "../../lib/api.js";
import { novaPath } from "../../lib/context.js";

interface NovaCatalog {
  product?: { code?: string; name?: string; description?: string };
  roles?: string[];
  agencies?: Array<{ code: string; city: string; group: string; tag: string }>;
  contexts?: string[];
  eventTypes?: string[];
}

interface ComplianceSettings {
  window_start_hour?: number;
  window_end_hour?: number;
  time_zone?: string;
  allowed_weekdays?: number[];
  voice_enabled?: boolean;
  whatsapp_enabled?: boolean;
  max_attempts_per_contact?: number;
  max_attempts_per_day?: number;
  rolling_window_days?: number;
  max_concurrent_calls?: number;
  min_hours_between_attempts?: number;
  respect_holidays?: boolean;
  meta_contactos_hoy?: number;
}

interface AgentConfig {
  product_flow: string;
  elevenlabs_agent_id?: string;
  elevenlabs_phone_number_id?: string;
  liwa_flow_id?: string;
  lead_context_templates?: Record<string, string>;
}

const NOVA_FLOW_ID_PATTERN = /^[a-z][a-z0-9_-]{1,79}$/;

export function NovaConfigTab({ tenantId }: { tenantId: string }) {
  const [catalog, setCatalog] = useState<NovaCatalog>();
  const [compliance, setCompliance] = useState<ComplianceSettings>({});
  const [agentConfigs, setAgentConfigs] = useState<AgentConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [newFlowId, setNewFlowId] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [cat, settings, agents] = await Promise.all([
        api.get<NovaCatalog>(novaPath(tenantId, "catalog")),
        api.get<ComplianceSettings>(novaPath(tenantId, "compliance/settings")).catch(() => ({})),
        api.get<AgentConfig[] | { items: AgentConfig[] }>(novaPath(tenantId, "agent-configs")).catch(() => [])
      ]);
      setCatalog(cat);
      setCompliance(settings ?? {});
      setAgentConfigs(Array.isArray(agents) ? agents : (agents.items ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function saveCompliance() {
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await api.put(novaPath(tenantId, "compliance/settings"), {
        window_start_hour: Number(compliance.window_start_hour ?? 8),
        window_end_hour: Number(compliance.window_end_hour ?? 19),
        time_zone: compliance.time_zone || "America/Bogota",
        allowed_weekdays: compliance.allowed_weekdays ?? [1, 2, 3, 4, 5, 6],
        voice_enabled: Boolean(compliance.voice_enabled ?? true),
        whatsapp_enabled: Boolean(compliance.whatsapp_enabled ?? true),
        max_attempts_per_day: Number(compliance.max_attempts_per_day ?? 2),
        max_attempts_per_contact: Number(compliance.max_attempts_per_contact ?? 4),
        rolling_window_days: Number(compliance.rolling_window_days ?? 7),
        max_concurrent_calls: Number(compliance.max_concurrent_calls ?? 10),
        min_hours_between_attempts: Number(compliance.min_hours_between_attempts ?? 4),
        respect_holidays: Boolean(compliance.respect_holidays ?? true),
        meta_contactos_hoy: Math.max(0, Math.floor(Number(compliance.meta_contactos_hoy ?? 0)) || 0)
      });
      setMessage("Compliance y operación guardados");
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function saveAgent(config: AgentConfig) {
    setSaving(true);
    setMessage(undefined);
    setError(undefined);
    try {
      await api.put(novaPath(tenantId, `agent-configs/${config.product_flow}`), {
        product_flow: config.product_flow,
        elevenlabs_agent_id: config.elevenlabs_agent_id || "pending",
        elevenlabs_phone_number_id: config.elevenlabs_phone_number_id || "pending",
        liwa_flow_id: config.liwa_flow_id || null,
        lead_context_templates: config.lead_context_templates ?? {}
      });
      setMessage(`Agent config ${config.product_flow} guardado`);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function addFlow() {
    const candidate = newFlowId.trim().toLowerCase();
    if (!NOVA_FLOW_ID_PATTERN.test(candidate)) {
      setError("El identificador debe empezar con una letra y usar solo minúsculas, números, guion o guion bajo.");
      return;
    }
    if (agentConfigs.some((config) => config.product_flow === candidate)) {
      setError("Ese flujo ya está configurado para el tenant.");
      return;
    }
    setError(undefined);
    setAgentConfigs((current) => [...current, { product_flow: candidate }]);
    setNewFlowId("");
  }

  if (loading) return <LoadingState label="Cargando configuración NOVA…" />;

  return (
    <div className="col" style={{ gap: 16 }}>
      {error ? <div className="banner">{error}</div> : null}
      {message ? <div className="banner ok">{message}</div> : null}

      <Card>
        <CardHead title="Producto" />
        <ul className="muted">
          <li>
            {catalog?.product?.name ?? "NOVA"} ({catalog?.product?.code ?? "NOVA"})
          </li>
          <li>{catalog?.product?.description ?? "Campañas de contacto proactivo."}</li>
          <li>Roles: {(catalog?.roles ?? []).join(", ") || "admin / supervisor / asesor"}</li>
        </ul>
      </Card>

      <Card>
        <CardHead title="Operación" />
        <label>
          Meta de contactos por día
          <input
            type="number"
            min={0}
            step={1}
            value={compliance.meta_contactos_hoy ?? 0}
            onChange={(e) =>
              setCompliance((c) => ({
                ...c,
                meta_contactos_hoy: Math.max(0, Math.floor(Number(e.target.value) || 0))
              }))
            }
          />
        </label>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          0 = sin meta. El Dashboard muestra Meta vs. resultado (voz + WhatsApp del periodo analytics).
        </p>
      </Card>

      <Card>
        <CardHead title="Compliance (ventana / frecuencia)" />
        <div className="grid two" style={{ gap: 12 }}>
          <label>
            Inicio (hora Bogotá)
            <input
              type="number"
              min={0}
              max={23}
              value={compliance.window_start_hour ?? 8}
              onChange={(e) => setCompliance((c) => ({ ...c, window_start_hour: Number(e.target.value) }))}
            />
          </label>
          <label>
            Fin (hora Bogotá)
            <input
              type="number"
              min={1}
              max={24}
              value={compliance.window_end_hour ?? 19}
              onChange={(e) => setCompliance((c) => ({ ...c, window_end_hour: Number(e.target.value) }))}
            />
          </label>
          <label>
            Máx. intentos / día
            <input
              type="number"
              min={1}
              value={compliance.max_attempts_per_day ?? 2}
              onChange={(e) => setCompliance((c) => ({ ...c, max_attempts_per_day: Number(e.target.value) }))}
            />
          </label>
          <label>
            Horas mín. entre intentos
            <input
              type="number"
              min={0}
              value={compliance.min_hours_between_attempts ?? 4}
              onChange={(e) => setCompliance((c) => ({ ...c, min_hours_between_attempts: Number(e.target.value) }))}
            />
          </label>
          <label>
            Máx. intentos / ventana
            <input
              type="number"
              min={1}
              value={compliance.max_attempts_per_contact ?? 4}
              onChange={(e) => setCompliance((c) => ({ ...c, max_attempts_per_contact: Number(e.target.value) }))}
            />
          </label>
          <label>
            Días de ventana móvil
            <input
              type="number"
              min={1}
              value={compliance.rolling_window_days ?? 7}
              onChange={(e) => setCompliance((c) => ({ ...c, rolling_window_days: Number(e.target.value) }))}
            />
          </label>
          <label>
            Máx. llamadas simultáneas
            <input
              type="number"
              min={1}
              value={compliance.max_concurrent_calls ?? 10}
              onChange={(e) => setCompliance((c) => ({ ...c, max_concurrent_calls: Number(e.target.value) }))}
            />
          </label>
          <label>
            Zona horaria IANA
            <input
              value={compliance.time_zone ?? "America/Bogota"}
              onChange={(e) => setCompliance((c) => ({ ...c, time_zone: e.target.value }))}
            />
          </label>
          <label>
            Días ISO permitidos (1=lunes)
            <input
              value={(compliance.allowed_weekdays ?? [1, 2, 3, 4, 5, 6]).join(",")}
              onChange={(e) =>
                setCompliance((c) => ({
                  ...c,
                  allowed_weekdays: e.target.value
                    .split(",")
                    .map(Number)
                    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
                }))
              }
            />
          </label>
        </div>
        <div className="row" style={{ gap: 16, marginTop: 12 }}>
          <label>
            <input
              type="checkbox"
              checked={compliance.voice_enabled ?? true}
              onChange={(e) => setCompliance((c) => ({ ...c, voice_enabled: e.target.checked }))}
            />{" "}
            Voz habilitada
          </label>
          <label>
            <input
              type="checkbox"
              checked={compliance.whatsapp_enabled ?? true}
              onChange={(e) => setCompliance((c) => ({ ...c, whatsapp_enabled: e.target.checked }))}
            />{" "}
            WhatsApp habilitado
          </label>
          <label>
            <input
              type="checkbox"
              checked={compliance.respect_holidays ?? true}
              onChange={(e) => setCompliance((c) => ({ ...c, respect_holidays: e.target.checked }))}
            />{" "}
            Respetar festivos CO
          </label>
        </div>
        <p className="tiny muted" style={{ marginTop: 8 }}>
          Gate WhatsApp: auto-send encendido por defecto (tipify positivo → flujo LIWA). Usa{" "}
          <code>POST_CALL_WHATSAPP_AUTO_SEND=false</code> para exigir revisión humana.
        </p>
        <button className="btn" style={{ marginTop: 12 }} disabled={saving} onClick={() => void saveCompliance()}>
          Guardar operación + compliance
        </button>
      </Card>

      <Card>
        <CardHead title="Agent config / product flow" />
        <div className="col" style={{ gap: 16 }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <label className="col" style={{ gap: 4, flex: "1 1 260px" }}>
              <span className="tiny muted">Identificador de flujo del tenant</span>
              <input
                value={newFlowId}
                placeholder="por-ejemplo: flujo_principal"
                onChange={(event) => setNewFlowId(event.target.value)}
              />
            </label>
            <button className="btn" type="button" disabled={!newFlowId.trim()} onClick={addFlow}>
              Añadir flujo
            </button>
          </div>
          {agentConfigs.length === 0 ? <EmptyState label="No hay flujos configurados para este tenant." /> : null}
          {agentConfigs.map((cfg, idx) => (
            <div key={cfg.product_flow} className="card nested">
              <strong>{cfg.product_flow}</strong>
              <div className="grid two" style={{ gap: 8, marginTop: 8 }}>
                <label>
                  ElevenLabs agent ID
                  <input
                    value={cfg.elevenlabs_agent_id ?? ""}
                    onChange={(e) => {
                      const next = [...agentConfigs];
                      next[idx] = { ...cfg, elevenlabs_agent_id: e.target.value };
                      setAgentConfigs(next);
                    }}
                  />
                </label>
                <label>
                  ElevenLabs phone number ID
                  <input
                    value={cfg.elevenlabs_phone_number_id ?? ""}
                    onChange={(e) => {
                      const next = [...agentConfigs];
                      next[idx] = { ...cfg, elevenlabs_phone_number_id: e.target.value };
                      setAgentConfigs(next);
                    }}
                  />
                </label>
                <label>
                  LIWA flow ID
                  <input
                    value={cfg.liwa_flow_id ?? ""}
                    onChange={(e) => {
                      const next = [...agentConfigs];
                      next[idx] = { ...cfg, liwa_flow_id: e.target.value };
                      setAgentConfigs(next);
                    }}
                  />
                </label>
              </div>
              <button className="btn" style={{ marginTop: 8 }} disabled={saving} onClick={() => void saveAgent(cfg)}>
                Guardar {cfg.product_flow}
              </button>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <CardHead title="Agencias" />
        <ul className="muted tiny" style={{ columns: 2, gap: 16 }}>
          {(catalog?.agencies ?? []).map((agency) => (
            <li key={agency.code}>
              {agency.code} · {agency.city} · {agency.tag}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHead title="Runtime / deudas" />
        <ul className="muted">
          <li>Voz = Neutral Dialer v3 real (sin mock); requiere overlay docker-compose.dialer.yml</li>
          <li>LIWA token no rotable — mitigar con webhook secret + monitoreo</li>
          <li>Core de negocio desacoplado mediante el adaptador configurado para el tenant</li>
          <li>Dominio HTTPS público requerido para webhooks LIWA/ElevenLabs</li>
        </ul>
      </Card>
    </div>
  );
}
