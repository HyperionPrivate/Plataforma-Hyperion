import { useState } from "react";
import { Card, CardHead, EmptyState } from "../../components/ui.js";
import type { CampaignRow } from "./types.js";

const WIZARD_STEPS = ["Información básica", "Audiencia", "Canales", "Guion y reintentos", "Revisar y lanzar"] as const;

export function NovaCampaignsTab({
  campaigns,
  canWriteOps,
  onCreate,
  onEnroll,
  onStart,
  onPause,
  onCancel
}: {
  campaigns: CampaignRow[];
  canWriteOps: boolean;
  onCreate: (input: {
    name: string;
    channel: "voice" | "whatsapp" | "mixed";
    product_flow: "renovacion" | "reactivacion";
  }) => Promise<string | undefined>;
  onEnroll: (campaignId: string, contactIds: string[]) => Promise<void>;
  onStart: (campaignId: string) => Promise<void>;
  onPause: (campaignId: string) => Promise<void>;
  onCancel: (campaignId: string) => Promise<void>;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("Renovaciones piloto");
  const [flow, setFlow] = useState<"renovacion" | "reactivacion">("renovacion");
  const [channelVoice, setChannelVoice] = useState(true);
  const [channelWa, setChannelWa] = useState(false);
  const [audienceSize, setAudienceSize] = useState(100);
  const [segmentFilter, setSegmentFilter] = useState("score>=70");
  const [retries, setRetries] = useState(2);
  const [scriptNote, setScriptNote] = useState("Saludo CoopFuturo → cupo preaprobado → agendar o enviar WhatsApp.");
  const [contactIdsText, setContactIdsText] = useState("");
  const [draftCampaignId, setDraftCampaignId] = useState<string>();
  const [busy, setBusy] = useState(false);

  function resolveChannel(): "voice" | "whatsapp" | "mixed" {
    if (channelVoice && channelWa) return "mixed";
    if (channelWa) return "whatsapp";
    return "voice";
  }

  async function createDraft() {
    if (!canWriteOps) return;
    setBusy(true);
    try {
      const id = await onCreate({
        name,
        channel: resolveChannel(),
        product_flow: flow
      });
      if (id) setDraftCampaignId(id);
    } finally {
      setBusy(false);
    }
  }

  async function enrollAndStart() {
    if (!canWriteOps) return;
    setBusy(true);
    try {
      let campaignId = draftCampaignId;
      if (!campaignId) {
        campaignId = await onCreate({
          name,
          channel: resolveChannel(),
          product_flow: flow
        });
        if (campaignId) setDraftCampaignId(campaignId);
      }
      if (!campaignId) return;
      const ids = contactIdsText
        .split(/[\s,;]+/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (ids.length > 0) {
        await onEnroll(campaignId, ids);
      }
      await onStart(campaignId);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card>
        <CardHead title="Asistente de campaña (5 pasos)" />
        <ol className="row" style={{ gap: 8, flexWrap: "wrap", listStyle: "none", padding: 0, margin: "0 0 16px" }}>
          {WIZARD_STEPS.map((label, index) => (
            <li key={label}>
              <button type="button" className={`chip${step === index ? " active" : ""}`} onClick={() => setStep(index)}>
                {index + 1}. {label}
              </button>
            </li>
          ))}
        </ol>

        {step === 0 ? (
          <div className="col" style={{ gap: 12 }}>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Nombre</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <div className="row" style={{ gap: 8 }}>
              {(
                [
                  ["renovacion", "Flujo A · Renovación"],
                  ["reactivacion", "Flujo B · Reactivación"]
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`chip${flow === id ? " active" : ""}`}
                  onClick={() => setFlow(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div className="col" style={{ gap: 12 }}>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Tamaño estimado (preview UI)</span>
              <input
                className="input"
                type="number"
                min={1}
                value={audienceSize}
                onChange={(e) => setAudienceSize(Number(e.target.value) || 1)}
              />
            </label>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Filtro / regla (no persistido)</span>
              <input className="input" value={segmentFilter} onChange={(e) => setSegmentFilter(e.target.value)} />
            </label>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Contact IDs para enroll (UUID, separados)</span>
              <textarea
                className="input"
                rows={4}
                value={contactIdsText}
                onChange={(e) => setContactIdsText(e.target.value)}
                placeholder="uuid1, uuid2…"
              />
            </label>
          </div>
        ) : null}

        {step === 2 ? (
          <div className="col" style={{ gap: 8 }}>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={channelVoice} onChange={(e) => setChannelVoice(e.target.checked)} />
              Canal voz
            </label>
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={channelWa} onChange={(e) => setChannelWa(e.target.checked)} />
              Canal WhatsApp
            </label>
          </div>
        ) : null}

        {step === 3 ? (
          <div className="col" style={{ gap: 12 }}>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Reintentos (preview)</span>
              <input
                className="input"
                type="number"
                min={0}
                max={5}
                value={retries}
                onChange={(e) => setRetries(Number(e.target.value) || 0)}
              />
            </label>
            <label className="col" style={{ gap: 4 }}>
              <span className="tiny muted">Nota de guion</span>
              <textarea className="input" rows={3} value={scriptNote} onChange={(e) => setScriptNote(e.target.value)} />
            </label>
          </div>
        ) : null}

        {step === 4 ? (
          <div className="col" style={{ gap: 8 }}>
            <p>
              <strong>{name}</strong> · {flow} · {resolveChannel()}
            </p>
            <p className="muted tiny">
              Audiencia estimada {audienceSize} · filtro {segmentFilter} · reintentos {retries}
            </p>
            <p className="muted tiny">Guion: {scriptNote}</p>
            {draftCampaignId ? <p className="tiny">Borrador: {draftCampaignId}</p> : null}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <button className="btn" type="button" disabled={!canWriteOps || busy} onClick={() => void createDraft()}>
                Crear borrador
              </button>
              <button
                className="btn btn-primary"
                type="button"
                disabled={!canWriteOps || busy || !name.trim()}
                onClick={() => void enrollAndStart()}
              >
                {busy ? "Lanzando…" : "Crear, enroll y lanzar"}
              </button>
            </div>
          </div>
        ) : null}

        <div className="row" style={{ gap: 8, marginTop: 16, justifyContent: "space-between" }}>
          <button
            className="btn"
            type="button"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Atrás
          </button>
          <button
            className="btn"
            type="button"
            disabled={step === WIZARD_STEPS.length - 1}
            onClick={() => setStep((s) => Math.min(WIZARD_STEPS.length - 1, s + 1))}
          >
            Continuar
          </button>
        </div>
      </Card>

      <Card>
        <CardHead title="Campañas existentes" />
        {campaigns.length === 0 ? (
          <EmptyState label="Sin campañas. Usa el asistente para crear la primera." />
        ) : (
          <ul className="col" style={{ gap: 8, listStyle: "none", padding: 0, margin: 0 }}>
            {campaigns.map((campaign) => (
              <li
                key={campaign.campaign_id}
                className="row"
                style={{ justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}
              >
                <span>
                  {campaign.name} · {campaign.product_flow} · {campaign.channel} · {campaign.status}
                </span>
                <span className="row" style={{ gap: 6 }}>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={!canWriteOps || campaign.status === "running"}
                    onClick={() => void onStart(campaign.campaign_id)}
                  >
                    Lanzar
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={!canWriteOps || campaign.status !== "running"}
                    onClick={() => void onPause(campaign.campaign_id)}
                  >
                    Pausar
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    disabled={!canWriteOps || campaign.status === "cancelled"}
                    onClick={() => void onCancel(campaign.campaign_id)}
                  >
                    Cancelar
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
