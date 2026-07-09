import {
  CalendarClock,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Link2,
  MessageCircle,
  PauseCircle,
  PlayCircle,
  Plus,
  QrCode,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Unplug,
  Upload
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  OperatorListItem,
  PulsoIrisAgendaBlock,
  PulsoIrisAvailabilityRule,
  PulsoIrisAppointmentType,
  PulsoIrisHoliday,
  PulsoIrisPayer,
  PulsoIrisPayerExclusion,
  PulsoIrisAgendaSettings,
  PulsoIrisProfessionalAppointmentType,
  PulsoIrisProfessional,
  PulsoIrisProfessionalSite,
  PulsoIrisSite,
  SofiaReadiness,
  WhatsAppIntegrationStatus,
  WhatsAppQr
} from "@hyperion/contracts";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, LoadingState, Pill } from "../components/ui.js";
import { api, SessionExpiredError } from "../lib/api.js";
import { normalizeImportPreview, type ImportPreview } from "../lib/agenda-model.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { LINE } from "../lib/format.js";
import { usePolling } from "../lib/hooks.js";
import { can } from "../lib/rbac.js";
import {
  canManageWhatsAppIntegration,
  canViewWhatsAppIntegration,
  isSafeQrDataUrl,
  WHATSAPP_PRIVATE_CHANNEL_NOTICE,
  whatsappStateLabel,
  whatsappStateTone
} from "../lib/whatsapp-model.js";

type Tab = "agenda" | "sites" | "integrations" | "operators" | "platform";
type AgendaTab = "general" | "professionals" | "schedules" | "payers" | "holidays" | "blocks" | "imports";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "agenda", label: "Agenda" },
  { id: "sites", label: "Sedes" },
  { id: "integrations", label: "Integraciones" },
  { id: "operators", label: "Operadores" },
  { id: "platform", label: "Estado de plataforma" }
];

const AGENDA_TABS: Array<{ id: AgendaTab; label: string }> = [
  { id: "general", label: "General" },
  { id: "professionals", label: "Profesionales" },
  { id: "schedules", label: "Horarios" },
  { id: "payers", label: "Convenios y exclusiones" },
  { id: "holidays", label: "Festivos" },
  { id: "blocks", label: "Bloqueos" },
  { id: "imports", label: "Importar / exportar" }
];

const WEEKDAYS = [
  { value: 1, label: "Lunes" },
  { value: 2, label: "Martes" },
  { value: 3, label: "Miercoles" },
  { value: 4, label: "Jueves" },
  { value: 5, label: "Viernes" },
  { value: 6, label: "Sabado" },
  { value: 0, label: "Domingo" }
];

export function ConfigPage() {
  const { session, tenant } = useConsole();
  const [tab, setTab] = useState<Tab>("agenda");
  const visibleTabs = TABS.filter((item) => {
    if (item.id === "operators") return can(session.operator.role, "manage:operators");
    if (item.id === "integrations") return canViewWhatsAppIntegration(session.operator.role);
    return true;
  });
  const canWriteConfig = can(session.operator.role, "write:config");

  return (
    <Layout title="Configuracion" subtitle={`Catalogo operativo de ${tenant.displayName}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {visibleTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`btn btn-sm${tab === item.id ? " btn-primary" : " btn-outline"}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "agenda" ? <AgendaConfiguration tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
      {tab === "sites" ? <SitesTab tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
      {tab === "integrations" && canViewWhatsAppIntegration(session.operator.role) ? (
        <IntegrationsTab tenantId={tenant.id} isAdmin={canManageWhatsAppIntegration(session.operator.role)} />
      ) : null}
      {tab === "operators" && can(session.operator.role, "manage:operators") ? <OperatorsTab /> : null}
      {tab === "platform" ? <PlatformTab /> : null}
    </Layout>
  );
}

function useCatalog<T>(path: string) {
  const { logout } = useConsole();
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const reload = useCallback(() => {
    setLoading(true);
    api
      .get<T[]>(path)
      .then((data) => {
        setItems(data);
        setError(undefined);
      })
      .catch((err) => {
        if (err instanceof SessionExpiredError) logout();
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [path, logout]);

  useEffect(() => reload(), [reload]);
  return { items, loading, error, reload };
}

function AgendaConfiguration({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const [tab, setTab] = useState<AgendaTab>("general");

  return (
    <section className="agenda-config" aria-label="Configuracion de agenda">
      <div className="subnav" role="tablist" aria-label="Secciones de agenda">
        {AGENDA_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`subnav-item${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      {tab === "general" ? <AgendaGeneralTab tenantId={tenantId} canWrite={canWrite} /> : null}
      {tab === "professionals" ? (
        <div className="col" style={{ gap: 16 }}>
          <ProfessionalsTab tenantId={tenantId} canWrite={canWrite} />
          <ProfessionalRelationsTab tenantId={tenantId} canWrite={canWrite} />
        </div>
      ) : null}
      {tab === "schedules" ? (
        <div className="col" style={{ gap: 16 }}>
          <TypesTab tenantId={tenantId} canWrite={canWrite} />
          <AvailabilityTab tenantId={tenantId} canWrite={canWrite} section="rules" />
        </div>
      ) : null}
      {tab === "payers" ? (
        <div className="col" style={{ gap: 16 }}>
          <PayersTab tenantId={tenantId} canWrite={canWrite} />
          <AvailabilityTab tenantId={tenantId} canWrite={canWrite} section="exclusions" />
        </div>
      ) : null}
      {tab === "holidays" ? <AvailabilityTab tenantId={tenantId} canWrite={canWrite} section="holidays" /> : null}
      {tab === "blocks" ? <AvailabilityTab tenantId={tenantId} canWrite={canWrite} section="blocks" /> : null}
      {tab === "imports" ? <ImportExportTab tenantId={tenantId} canWrite={canWrite} /> : null}
    </section>
  );
}

function AgendaGeneralTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const { logout } = useConsole();
  const path = tenantPath(tenantId, "config/agenda-settings");
  const [settings, setSettings] = useState<PulsoIrisAgendaSettings>();
  const [draft, setDraft] = useState<PulsoIrisAgendaSettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .get<PulsoIrisAgendaSettings>(path)
      .then((value) => {
        setSettings(value);
        setDraft(value);
        setError(undefined);
      })
      .catch((err) => {
        if (err instanceof SessionExpiredError) logout();
        else setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [logout, path]);

  useEffect(() => reload(), [reload]);

  const setNumber = (key: keyof PulsoIrisAgendaSettings, value: string) => {
    setDraft((current) => (current ? { ...current, [key]: Number(value) } : current));
    setSaved(false);
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setError(undefined);
    try {
      const updated = await api.patch<PulsoIrisAgendaSettings>(path, {
        mode: draft.mode,
        timezone: draft.timezone,
        bookingHorizonDays: draft.bookingHorizonDays,
        holdDurationMinutes: draft.holdDurationMinutes,
        maxAlternatives: draft.maxAlternatives,
        maxReschedules: draft.maxReschedules,
        externalConfirmationSlaMinutes: draft.externalConfirmationSlaMinutes,
        externalReferenceRequired: draft.externalReferenceRequired,
        capacityPolicy: draft.capacityPolicy,
        status: draft.status
      });
      setSettings(updated);
      setDraft(updated);
      setSaved(true);
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingState />;
  if (!draft) {
    return (
      <Card>
        <div className="banner between">
          <span>{error ?? "No fue posible cargar la configuracion de agenda."}</span>
          <button className="btn btn-outline btn-sm" type="button" onClick={reload}>
            <RefreshCw size={15} /> Reintentar
          </button>
        </div>
      </Card>
    );
  }

  const dirty = JSON.stringify(settings) !== JSON.stringify(draft);
  return (
    <Card>
      <CardHead
        title="Configuracion general"
        icon={<CalendarClock size={18} />}
        trailing={
          <Pill tone={draft.status === "active" ? "green" : "amber"}>
            {draft.status === "active" ? "Agenda activa" : "Agenda pausada"}
          </Pill>
        }
      />
      <div className="card-pad settings-grid">
        <label className="field">
          <span>Modo de agenda</span>
          <select
            className="select"
            value={draft.mode}
            onChange={(event) => {
              const mode = event.target.value as PulsoIrisAgendaSettings["mode"];
              setDraft({
                ...draft,
                mode,
                externalReferenceRequired: mode === "hybrid_manual" ? true : draft.externalReferenceRequired
              });
              setSaved(false);
            }}
            disabled={!canWrite}
          >
            <option value="hybrid_manual">Hibrido manual</option>
            <option value="internal">Interno</option>
            <option value="legacy_integrated" disabled>
              Legado integrado (sin proveedor)
            </option>
          </select>
        </label>
        <label className="field">
          <span>Zona horaria</span>
          <input
            className="input"
            value={draft.timezone}
            onChange={(event) => {
              setDraft({ ...draft, timezone: event.target.value });
              setSaved(false);
            }}
            disabled={!canWrite}
          />
        </label>
        <NumericSetting
          label="Horizonte de agendamiento (dias)"
          value={draft.bookingHorizonDays}
          min={1}
          max={730}
          disabled={!canWrite}
          onChange={(value) => setNumber("bookingHorizonDays", value)}
        />
        <NumericSetting
          label="Reserva temporal (minutos)"
          value={draft.holdDurationMinutes}
          min={1}
          max={1440}
          disabled={!canWrite}
          onChange={(value) => setNumber("holdDurationMinutes", value)}
        />
        <NumericSetting
          label="Alternativas maximas"
          value={draft.maxAlternatives}
          min={1}
          max={20}
          disabled={!canWrite}
          onChange={(value) => setNumber("maxAlternatives", value)}
        />
        <NumericSetting
          label="Reagendamientos maximos"
          value={draft.maxReschedules}
          min={0}
          max={20}
          disabled={!canWrite}
          onChange={(value) => setNumber("maxReschedules", value)}
        />
        <NumericSetting
          label="SLA de confirmacion externa (minutos)"
          value={draft.externalConfirmationSlaMinutes}
          min={1}
          max={10080}
          disabled={!canWrite}
          onChange={(value) => setNumber("externalConfirmationSlaMinutes", value)}
        />
        <label className="field">
          <span>Politica de capacidad</span>
          <select
            className="select"
            value={draft.capacityPolicy}
            onChange={(event) => {
              setDraft({ ...draft, capacityPolicy: event.target.value as "strict" });
              setSaved(false);
            }}
            disabled={!canWrite}
          >
            <option value="strict">Estricta por franja</option>
          </select>
        </label>
        <label className="field">
          <span>Estado</span>
          <select
            className="select"
            value={draft.status}
            onChange={(event) => {
              setDraft({ ...draft, status: event.target.value as PulsoIrisAgendaSettings["status"] });
              setSaved(false);
            }}
            disabled={!canWrite}
          >
            <option value="active">Activa</option>
            <option value="paused">Pausada</option>
          </select>
        </label>
        <label className="toggle-field">
          <input
            type="checkbox"
            checked={draft.externalReferenceRequired}
            onChange={(event) => {
              setDraft({ ...draft, externalReferenceRequired: event.target.checked });
              setSaved(false);
            }}
            disabled={!canWrite || draft.mode === "hybrid_manual"}
          />
          <span>
            <strong>Referencia externa obligatoria</strong>
            <small>Siempre se exige en modo hibrido manual.</small>
          </span>
        </label>
      </div>
      {error ? <div className="banner">{error}</div> : null}
      {canWrite ? (
        <div className="card-actions">
          {saved ? (
            <span className="row small" style={{ color: "var(--green-dark)" }}>
              <CheckCircle2 size={16} /> Cambios guardados
            </span>
          ) : (
            <span className="small muted">{dirty ? "Hay cambios sin guardar" : "Configuracion al dia"}</span>
          )}
          <button className="btn btn-primary" type="button" onClick={() => void save()} disabled={saving || !dirty}>
            <Save size={16} /> Guardar
          </button>
        </div>
      ) : null}
    </Card>
  );
}

function NumericSetting({
  label,
  value,
  min,
  max,
  disabled,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max?: number;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
    </label>
  );
}

function SitesTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const path = tenantPath(tenantId, "config/sites");
  const { items, loading, error, reload } = useCatalog<PulsoIrisSite>(path);
  const [name, setName] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (name.trim().length < 2) return;
    setSaving(true);
    try {
      await api.post(path, { name, city: city || undefined, address: address || undefined });
      setName("");
      setCity("");
      setAddress("");
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title={`Sedes (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
      {canWrite ? (
        <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
          <input
            className="input"
            placeholder="Nombre de la sede"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <input
            className="input"
            placeholder="Ciudad"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            style={{ maxWidth: 160 }}
          />
          <input
            className="input"
            placeholder="Direccion"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving}>
            <Plus size={15} /> Agregar
          </button>
        </div>
      ) : null}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : items.length === 0 ? (
        <EmptyState label="Sin sedes" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Sede</th>
              <th>Ciudad</th>
              <th>Direccion</th>
              <th>Estado</th>
              {canWrite ? <th>Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((site) => (
              <tr key={site.id}>
                <td>
                  <strong className="small">{site.name}</strong>
                </td>
                <td className="small muted">{site.city ?? "-"}</td>
                <td className="small muted">{site.address ?? "-"}</td>
                <td>
                  <Pill tone={site.status === "active" ? "green" : "amber"}>{site.status}</Pill>
                </td>
                {canWrite ? (
                  <td>
                    <StatusToggle path={path} id={site.id} status={site.status} onDone={reload} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ProfessionalsTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const path = tenantPath(tenantId, "config/professionals");
  const { items, loading, error, reload } = useCatalog<PulsoIrisProfessional>(path);
  const [name, setName] = useState("");
  const [type, setType] = useState<"ophthalmologist" | "optometrist">("ophthalmologist");
  const [subspecialty, setSubspecialty] = useState("");
  const [isPilot, setIsPilot] = useState(false);
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (name.trim().length < 2) return;
    setSaving(true);
    try {
      await api.post(path, { name, professionalType: type, subspecialty: subspecialty || undefined, isPilot });
      setName("");
      setSubspecialty("");
      setIsPilot(false);
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title={`Profesionales (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
      {canWrite ? (
        <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
          <input
            className="input"
            placeholder="Nombre"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <select className="select" value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="ophthalmologist">Oftalmologo</option>
            <option value="optometrist">Optometra</option>
          </select>
          <input
            className="input"
            placeholder="Subespecialidad"
            value={subspecialty}
            onChange={(e) => setSubspecialty(e.target.value)}
            style={{ maxWidth: 200 }}
          />
          <label className="row small muted">
            <input type="checkbox" checked={isPilot} onChange={(event) => setIsPilot(event.target.checked)} />
            Piloto
          </label>
          <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving}>
            <Plus size={15} /> Agregar
          </button>
        </div>
      ) : null}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : items.length === 0 ? (
        <EmptyState label="Sin profesionales configurados" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Subespecialidad</th>
              <th>Modalidad</th>
              <th>Estado</th>
              {canWrite ? <th>Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((pro) => (
              <tr key={pro.id}>
                <td>
                  <strong className="small">{pro.name}</strong>
                </td>
                <td className="small muted">
                  {pro.professionalType === "ophthalmologist" ? "Oftalmologo" : "Optometra"}
                </td>
                <td className="small muted">{pro.subspecialty ?? "-"}</td>
                <td>{pro.isPilot ? <Pill tone="blue">Piloto</Pill> : <span className="small muted">Regular</span>}</td>
                <td>
                  <Pill tone={pro.status === "active" ? "green" : "amber"}>{pro.status}</Pill>
                </td>
                {canWrite ? (
                  <td>
                    <StatusToggle path={path} id={pro.id} status={pro.status} onDone={reload} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ProfessionalRelationsTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const { logout } = useConsole();
  const sitesPath = tenantPath(tenantId, "config/sites");
  const professionalsPath = tenantPath(tenantId, "config/professionals");
  const typesPath = tenantPath(tenantId, "config/appointment-types");
  const professionalSitesPath = tenantPath(tenantId, "config/professional-sites");
  const professionalTypesPath = tenantPath(tenantId, "config/professional-appointment-types");
  const sites = useCatalog<PulsoIrisSite>(sitesPath);
  const professionals = useCatalog<PulsoIrisProfessional>(professionalsPath);
  const appointmentTypes = useCatalog<PulsoIrisAppointmentType>(typesPath);
  const professionalSites = useCatalog<PulsoIrisProfessionalSite>(professionalSitesPath);
  const professionalTypes = useCatalog<PulsoIrisProfessionalAppointmentType>(professionalTypesPath);
  const [professionalId, setProfessionalId] = useState("");
  const [siteId, setSiteId] = useState("");
  const [appointmentProfessionalId, setAppointmentProfessionalId] = useState("");
  const [appointmentTypeId, setAppointmentTypeId] = useState("");
  const [saving, setSaving] = useState<"site" | "type">();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const firstProfessional = professionals.items[0]?.id ?? "";
    const firstSite = sites.items[0]?.id ?? "";
    const firstType = appointmentTypes.items[0]?.id ?? "";
    if (!professionalId && firstProfessional) setProfessionalId(firstProfessional);
    if (!appointmentProfessionalId && firstProfessional) setAppointmentProfessionalId(firstProfessional);
    if (!siteId && firstSite) setSiteId(firstSite);
    if (!appointmentTypeId && firstType) setAppointmentTypeId(firstType);
  }, [
    appointmentProfessionalId,
    appointmentTypeId,
    appointmentTypes.items,
    professionalId,
    professionals.items,
    siteId,
    sites.items
  ]);

  const professionalById = useMemo(
    () => new Map(professionals.items.map((item) => [item.id, item.name])),
    [professionals.items]
  );
  const siteById = useMemo(() => new Map(sites.items.map((item) => [item.id, item.name])), [sites.items]);
  const typeById = useMemo(
    () => new Map(appointmentTypes.items.map((item) => [item.id, item.name])),
    [appointmentTypes.items]
  );

  const addSite = async () => {
    if (!professionalId || !siteId) return;
    setSaving("site");
    setError(undefined);
    try {
      await api.post(professionalSitesPath, { professionalId, siteId });
      professionalSites.reload();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(undefined);
    }
  };

  const addType = async () => {
    if (!appointmentProfessionalId || !appointmentTypeId) return;
    setSaving("type");
    setError(undefined);
    try {
      await api.post(professionalTypesPath, { professionalId: appointmentProfessionalId, appointmentTypeId });
      professionalTypes.reload();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(undefined);
    }
  };

  const loading =
    sites.loading ||
    professionals.loading ||
    appointmentTypes.loading ||
    professionalSites.loading ||
    professionalTypes.loading;
  const loadError =
    sites.error ?? professionals.error ?? appointmentTypes.error ?? professionalSites.error ?? professionalTypes.error;

  return (
    <div className="config-split">
      <Card>
        <CardHead title={`Sedes autorizadas (${professionalSites.items.length})`} icon={<Link2 size={18} />} />
        {canWrite ? (
          <div className="card-pad compact-form">
            <select
              className="select"
              value={professionalId}
              onChange={(event) => setProfessionalId(event.target.value)}
              aria-label="Profesional para relacionar con sede"
            >
              {professionals.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={siteId}
              onChange={(event) => setSiteId(event.target.value)}
              aria-label="Sede autorizada"
            >
              {sites.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => void addSite()}
              disabled={saving === "site" || !professionalId || !siteId}
            >
              <Plus size={15} /> Relacionar
            </button>
          </div>
        ) : null}
        {loading ? (
          <LoadingState />
        ) : loadError ? (
          <div className="banner">{loadError}</div>
        ) : professionalSites.items.length === 0 ? (
          <EmptyState label="Sin relaciones profesional-sede" />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Profesional</th>
                  <th>Sede</th>
                  <th>Estado</th>
                  {canWrite ? <th>Accion</th> : null}
                </tr>
              </thead>
              <tbody>
                {professionalSites.items.map((item) => (
                  <tr key={item.id}>
                    <td className="small">{professionalById.get(item.professionalId) ?? item.professionalId}</td>
                    <td className="small muted">{siteById.get(item.siteId) ?? item.siteId}</td>
                    <td>
                      <Pill tone={item.status === "active" ? "green" : "amber"}>{item.status}</Pill>
                    </td>
                    {canWrite ? (
                      <td>
                        <StatusToggle
                          path={professionalSitesPath}
                          id={item.id}
                          status={item.status}
                          onDone={professionalSites.reload}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHead
          title={`Tipos de cita autorizados (${professionalTypes.items.length})`}
          icon={<CalendarClock size={18} />}
        />
        {canWrite ? (
          <div className="card-pad compact-form">
            <select
              className="select"
              value={appointmentProfessionalId}
              onChange={(event) => setAppointmentProfessionalId(event.target.value)}
              aria-label="Profesional para relacionar con tipo de cita"
            >
              {professionals.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <select
              className="select"
              value={appointmentTypeId}
              onChange={(event) => setAppointmentTypeId(event.target.value)}
              aria-label="Tipo de cita autorizado"
            >
              {appointmentTypes.items.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <button
              className="btn btn-primary btn-sm"
              type="button"
              onClick={() => void addType()}
              disabled={saving === "type" || !appointmentProfessionalId || !appointmentTypeId}
            >
              <Plus size={15} /> Autorizar
            </button>
          </div>
        ) : null}
        {loading ? (
          <LoadingState />
        ) : loadError ? (
          <div className="banner">{loadError}</div>
        ) : professionalTypes.items.length === 0 ? (
          <EmptyState label="Sin tipos de cita asociados" />
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Profesional</th>
                  <th>Tipo de cita</th>
                  <th>Estado</th>
                  {canWrite ? <th>Accion</th> : null}
                </tr>
              </thead>
              <tbody>
                {professionalTypes.items.map((item) => (
                  <tr key={item.id}>
                    <td className="small">{professionalById.get(item.professionalId) ?? item.professionalId}</td>
                    <td className="small muted">{typeById.get(item.appointmentTypeId) ?? item.appointmentTypeId}</td>
                    <td>
                      <Pill tone={item.status === "active" ? "green" : "amber"}>{item.status}</Pill>
                    </td>
                    {canWrite ? (
                      <td>
                        <StatusToggle
                          path={professionalTypesPath}
                          id={item.id}
                          status={item.status}
                          onDone={professionalTypes.reload}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {error ? <div className="banner config-span">{error}</div> : null}
    </div>
  );
}

function PayersTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const path = tenantPath(tenantId, "config/payers");
  const { items, loading, error, reload } = useCatalog<PulsoIrisPayer>(path);
  const [name, setName] = useState("");
  const [group, setGroup] = useState<"eps" | "private_prepaid" | "policy" | "particular" | "other">("eps");
  const [requiresAuthorization, setRequiresAuthorization] = useState(true);
  const [saving, setSaving] = useState(false);
  const groupLabels: Record<string, string> = {
    eps: "EPS",
    private_prepaid: "Prepagada",
    policy: "Poliza",
    particular: "Particular",
    other: "Otro"
  };

  const add = async () => {
    if (name.trim().length < 2) return;
    setSaving(true);
    try {
      await api.post(path, { name, group, requiresAuthorization });
      setName("");
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title={`Convenios (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
      {canWrite ? (
        <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
          <input
            className="input"
            placeholder="Nombre del convenio"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <select className="select" value={group} onChange={(e) => setGroup(e.target.value as typeof group)}>
            <option value="eps">EPS</option>
            <option value="private_prepaid">Prepagada</option>
            <option value="policy">Poliza</option>
            <option value="particular">Particular</option>
            <option value="other">Otro</option>
          </select>
          <label className="row small muted">
            <input
              type="checkbox"
              checked={requiresAuthorization}
              onChange={(e) => setRequiresAuthorization(e.target.checked)}
            />
            Autorizacion
          </label>
          <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving}>
            <Plus size={15} /> Agregar
          </button>
        </div>
      ) : null}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : items.length === 0 ? (
        <EmptyState label="Sin convenios" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Convenio</th>
              <th>Grupo</th>
              <th>Autorizacion</th>
              <th>Estado</th>
              {canWrite ? <th>Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((payer) => (
              <tr key={payer.id}>
                <td>
                  <strong className="small">{payer.name}</strong>
                </td>
                <td className="small muted">{groupLabels[payer.group] ?? payer.group}</td>
                <td>
                  {payer.requiresAuthorization ? (
                    <Pill tone="amber">Requiere</Pill>
                  ) : (
                    <span className="small muted">No</span>
                  )}
                </td>
                <td>
                  <Pill tone={payer.status === "active" ? "green" : "amber"}>{payer.status}</Pill>
                </td>
                {canWrite ? (
                  <td>
                    <StatusToggle path={path} id={payer.id} status={payer.status} onDone={reload} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function TypesTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const path = tenantPath(tenantId, "config/appointment-types");
  const { items, loading, error, reload } = useCatalog<PulsoIrisAppointmentType>(path);
  const [name, setName] = useState("");
  const [category, setCategory] = useState<"consulta" | "ayuda_dx" | "valoracion_qx" | "control_post">("consulta");
  const [durationMin, setDurationMin] = useState("20");
  const [bookableByIa, setBookableByIa] = useState(true);
  const [preparationText, setPreparationText] = useState("");
  const [saving, setSaving] = useState(false);
  const categoryLabels: Record<string, string> = {
    consulta: "Consulta",
    ayuda_dx: "Ayuda diagnostica",
    valoracion_qx: "Valoracion Qx",
    control_post: "Control post"
  };

  const add = async () => {
    if (name.trim().length < 2) return;
    setSaving(true);
    try {
      await api.post(path, {
        name,
        category,
        durationMin: Number(durationMin),
        bookableByIa,
        preparationText: preparationText || undefined
      });
      setName("");
      setPreparationText("");
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title={`Tipos de cita (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
      {canWrite ? (
        <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
          <input
            className="input"
            placeholder="Nombre del tipo"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{ maxWidth: 240 }}
          />
          <select className="select" value={category} onChange={(e) => setCategory(e.target.value as typeof category)}>
            <option value="consulta">Consulta</option>
            <option value="ayuda_dx">Ayuda diagnostica</option>
            <option value="valoracion_qx">Valoracion Qx</option>
            <option value="control_post">Control post</option>
          </select>
          <input
            className="input"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => setDurationMin(e.target.value)}
            style={{ maxWidth: 96 }}
          />
          <label className="row small muted">
            <input type="checkbox" checked={bookableByIa} onChange={(e) => setBookableByIa(e.target.checked)} />
            Agendable por IA
          </label>
          <input
            className="input"
            placeholder="Preparacion"
            value={preparationText}
            onChange={(e) => setPreparationText(e.target.value)}
            style={{ maxWidth: 260 }}
          />
          <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving}>
            <Plus size={15} /> Agregar
          </button>
        </div>
      ) : null}
      {loading ? (
        <LoadingState />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : items.length === 0 ? (
        <EmptyState label="Sin tipos de cita" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Categoria</th>
              <th>Duracion</th>
              <th>Agendable IA</th>
              <th>Estado</th>
              {canWrite ? <th>Acciones</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((type) => (
              <tr key={type.id}>
                <td>
                  <strong className="small">{type.name}</strong>
                  {type.preparationText ? <div className="tiny muted">Requiere preparacion</div> : null}
                </td>
                <td className="small muted">{categoryLabels[type.category] ?? type.category}</td>
                <td className="small muted">{type.durationMin} min</td>
                <td>{type.bookableByIa ? <Pill tone="green">Si</Pill> : <Pill tone="amber">Manual</Pill>}</td>
                <td>
                  <Pill tone={type.status === "active" ? "green" : "amber"}>{type.status}</Pill>
                </td>
                {canWrite ? (
                  <td>
                    <StatusToggle path={path} id={type.id} status={type.status} onDone={reload} />
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function AvailabilityTab({
  tenantId,
  canWrite,
  section
}: {
  tenantId: string;
  canWrite: boolean;
  section: "rules" | "blocks" | "holidays" | "exclusions";
}) {
  const { logout } = useConsole();
  const rulesPath = tenantPath(tenantId, "config/availability-rules");
  const blocksPath = tenantPath(tenantId, "config/agenda-blocks");
  const holidaysPath = tenantPath(tenantId, "config/holidays");
  const exclusionsPath = tenantPath(tenantId, "config/payer-exclusions");
  const sitesPath = tenantPath(tenantId, "config/sites");
  const professionalsPath = tenantPath(tenantId, "config/professionals");
  const payersPath = tenantPath(tenantId, "config/payers");
  const typesPath = tenantPath(tenantId, "config/appointment-types");
  const rules = useCatalog<PulsoIrisAvailabilityRule>(rulesPath);
  const blocks = useCatalog<PulsoIrisAgendaBlock>(blocksPath);
  const holidays = useCatalog<PulsoIrisHoliday>(holidaysPath);
  const exclusions = useCatalog<PulsoIrisPayerExclusion>(exclusionsPath);
  const sites = useCatalog<PulsoIrisSite>(sitesPath);
  const professionals = useCatalog<PulsoIrisProfessional>(professionalsPath);
  const payers = useCatalog<PulsoIrisPayer>(payersPath);
  const appointmentTypes = useCatalog<PulsoIrisAppointmentType>(typesPath);
  const [siteId, setSiteId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [appointmentTypeId, setAppointmentTypeId] = useState("");
  const [weekday, setWeekday] = useState("1");
  const [startsAt, setStartsAt] = useState("08:00");
  const [endsAt, setEndsAt] = useState("12:00");
  const [slotDurationMin, setSlotDurationMin] = useState("20");
  const [capacity, setCapacity] = useState("1");
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [effectiveTo, setEffectiveTo] = useState("");
  const [saving, setSaving] = useState(false);
  const [blockStartsAt, setBlockStartsAt] = useState(() => defaultLocalDateTime(8));
  const [blockEndsAt, setBlockEndsAt] = useState(() => defaultLocalDateTime(9));
  const [blockType, setBlockType] = useState<"block" | "absence" | "vacation">("block");
  const [blockSiteId, setBlockSiteId] = useState("");
  const [blockProfessionalId, setBlockProfessionalId] = useState("");
  const [blockAppointmentTypeId, setBlockAppointmentTypeId] = useState("");
  const [blockReason, setBlockReason] = useState("");
  const [savingBlock, setSavingBlock] = useState(false);
  const [holidayDate, setHolidayDate] = useState("");
  const [holidayName, setHolidayName] = useState("");
  const [savingHoliday, setSavingHoliday] = useState(false);
  const [exclusionProfessionalId, setExclusionProfessionalId] = useState("");
  const [exclusionPayerId, setExclusionPayerId] = useState("");
  const [savingExclusion, setSavingExclusion] = useState(false);
  const [actionError, setActionError] = useState<string>();

  useEffect(() => {
    if (!siteId && sites.items[0]) setSiteId(sites.items[0].id);
    if (!professionalId && professionals.items[0]) setProfessionalId(professionals.items[0].id);
    if (!appointmentTypeId && appointmentTypes.items[0]) setAppointmentTypeId(appointmentTypes.items[0].id);
    if (!exclusionProfessionalId && professionals.items[0]) setExclusionProfessionalId(professionals.items[0].id);
    if (!exclusionPayerId && payers.items[0]) setExclusionPayerId(payers.items[0].id);
  }, [
    appointmentTypeId,
    appointmentTypes.items,
    exclusionPayerId,
    exclusionProfessionalId,
    payers.items,
    professionalId,
    professionals.items,
    siteId,
    sites.items
  ]);

  const siteById = new Map(sites.items.map((site) => [site.id, site.name]));
  const professionalById = new Map(professionals.items.map((professional) => [professional.id, professional.name]));
  const payerById = new Map(payers.items.map((payer) => [payer.id, payer.name]));
  const typeById = new Map(appointmentTypes.items.map((type) => [type.id, type.name]));

  const add = async () => {
    if (!canCreate) return;
    setSaving(true);
    setActionError(undefined);
    try {
      await api.post(rulesPath, {
        siteId,
        professionalId,
        appointmentTypeId,
        weekday: Number(weekday),
        startsAt,
        endsAt,
        slotDurationMin: Number(slotDurationMin),
        capacity: Number(capacity),
        effectiveFrom: effectiveFrom || undefined,
        effectiveTo: effectiveTo || undefined
      });
      rules.reload();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const addBlock = async () => {
    if (!blockReason.trim() || new Date(blockStartsAt).getTime() >= new Date(blockEndsAt).getTime()) return;
    setSavingBlock(true);
    setActionError(undefined);
    try {
      await api.post(blocksPath, {
        siteId: blockSiteId || undefined,
        professionalId: blockProfessionalId || undefined,
        appointmentTypeId: blockAppointmentTypeId || undefined,
        startsAt: new Date(blockStartsAt).toISOString(),
        endsAt: new Date(blockEndsAt).toISOString(),
        blockType,
        reason: blockReason
      });
      setBlockReason("");
      blocks.reload();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingBlock(false);
    }
  };

  const addHoliday = async () => {
    if (!holidayDate || !holidayName.trim()) return;
    setSavingHoliday(true);
    setActionError(undefined);
    try {
      await api.post(holidaysPath, { holidayDate, name: holidayName.trim() });
      setHolidayName("");
      holidays.reload();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingHoliday(false);
    }
  };

  const addExclusion = async () => {
    if (!exclusionProfessionalId || !exclusionPayerId) return;
    setSavingExclusion(true);
    setActionError(undefined);
    try {
      await api.post(exclusionsPath, {
        professionalId: exclusionProfessionalId,
        payerId: exclusionPayerId
      });
      exclusions.reload();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingExclusion(false);
    }
  };

  const loading =
    section === "holidays"
      ? holidays.loading
      : section === "exclusions"
        ? exclusions.loading || professionals.loading || payers.loading
        : section === "blocks"
          ? blocks.loading || sites.loading || professionals.loading || appointmentTypes.loading
          : rules.loading || sites.loading || professionals.loading || appointmentTypes.loading;
  const catalogError =
    section === "holidays"
      ? holidays.error
      : section === "exclusions"
        ? (exclusions.error ?? professionals.error ?? payers.error)
        : section === "blocks"
          ? (blocks.error ?? sites.error ?? professionals.error ?? appointmentTypes.error)
          : (rules.error ?? sites.error ?? professionals.error ?? appointmentTypes.error);
  const error = actionError ?? catalogError;
  const selectedAppointmentType = appointmentTypes.items.find((item) => item.id === appointmentTypeId);
  const validTimeRange = startsAt < endsAt;
  const validDuration = Number(slotDurationMin) >= (selectedAppointmentType?.durationMin ?? 1);
  const validEffectiveRange = !effectiveFrom || !effectiveTo || effectiveFrom <= effectiveTo;
  const validBlockRange = new Date(blockStartsAt).getTime() < new Date(blockEndsAt).getTime();
  const canCreate =
    canWrite &&
    Boolean(siteId && professionalId && appointmentTypeId) &&
    validTimeRange &&
    validDuration &&
    validEffectiveRange &&
    Number(capacity) > 0;
  const ruleValidation = !validTimeRange
    ? "La hora final debe ser posterior a la inicial."
    : !validDuration
      ? `La duracion debe ser al menos ${selectedAppointmentType?.durationMin ?? 1} minutos para este tipo de cita.`
      : !validEffectiveRange
        ? "La vigencia final debe ser posterior a la inicial."
        : undefined;

  return (
    <div className="col" style={{ gap: 16 }}>
      {section === "rules" ? (
        <Card>
          <CardHead
            title={`Reglas de disponibilidad (${rules.items.length})`}
            icon={<CalendarClock size={18} />}
            trailing={<ReloadButton onClick={rules.reload} />}
          />
          {canWrite ? (
            <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
              <select className="select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {sites.items.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
              <select className="select" value={professionalId} onChange={(e) => setProfessionalId(e.target.value)}>
                {professionals.items.map((professional) => (
                  <option key={professional.id} value={professional.id}>
                    {professional.name}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={appointmentTypeId}
                onChange={(e) => setAppointmentTypeId(e.target.value)}
              >
                {appointmentTypes.items.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
              <select className="select" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                {WEEKDAYS.map((day) => (
                  <option key={day.value} value={day.value}>
                    {day.label}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="time"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                style={{ maxWidth: 112 }}
              />
              <input
                className="input"
                type="time"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                style={{ maxWidth: 112 }}
              />
              <input
                className="input"
                type="number"
                min={5}
                value={slotDurationMin}
                onChange={(e) => setSlotDurationMin(e.target.value)}
                style={{ maxWidth: 92 }}
              />
              <input
                className="input"
                type="number"
                min={1}
                value={capacity}
                onChange={(e) => setCapacity(e.target.value)}
                style={{ maxWidth: 92 }}
              />
              <label className="inline-field">
                <span>Vigente desde</span>
                <input
                  className="input"
                  type="date"
                  value={effectiveFrom}
                  onChange={(event) => setEffectiveFrom(event.target.value)}
                />
              </label>
              <label className="inline-field">
                <span>Hasta</span>
                <input
                  className="input"
                  type="date"
                  value={effectiveTo}
                  min={effectiveFrom || undefined}
                  onChange={(event) => setEffectiveTo(event.target.value)}
                />
              </label>
              <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving || !canCreate}>
                <Plus size={15} /> Agregar
              </button>
            </div>
          ) : null}
          {canWrite && ruleValidation ? <div className="form-warning">{ruleValidation}</div> : null}
          {loading ? (
            <LoadingState />
          ) : error ? (
            <div className="banner">{error}</div>
          ) : rules.items.length === 0 ? (
            <EmptyState label="Sin reglas de disponibilidad" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Dia</th>
                  <th>Horario</th>
                  <th>Sede</th>
                  <th>Profesional</th>
                  <th>Tipo de cita</th>
                  <th>Capacidad</th>
                  <th>Estado</th>
                  {canWrite ? <th>Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {rules.items.map((rule) => (
                  <tr key={rule.id}>
                    <td className="small">{weekdayLabel(rule.weekday)}</td>
                    <td>
                      <strong className="small">
                        {shortTime(rule.startsAt)} - {shortTime(rule.endsAt)}
                      </strong>
                      <div className="tiny muted">{rule.slotDurationMin} min por slot</div>
                      <div className="tiny muted">
                        {rule.effectiveFrom ?? "Sin inicio"} / {rule.effectiveTo ?? "Sin fin"}
                      </div>
                    </td>
                    <td className="small muted">{siteById.get(rule.siteId) ?? rule.siteId}</td>
                    <td className="small muted">{professionalById.get(rule.professionalId) ?? rule.professionalId}</td>
                    <td className="small muted">{typeById.get(rule.appointmentTypeId) ?? rule.appointmentTypeId}</td>
                    <td className="small muted">{rule.capacity}</td>
                    <td>
                      <Pill tone={rule.status === "active" ? "green" : "amber"}>{rule.status}</Pill>
                    </td>
                    {canWrite ? (
                      <td>
                        <StatusToggle path={rulesPath} id={rule.id} status={rule.status} onDone={rules.reload} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {section === "blocks" ? (
        <Card>
          <CardHead
            title={`Bloqueos de agenda (${blocks.items.length})`}
            trailing={<ReloadButton onClick={blocks.reload} />}
          />
          {canWrite ? (
            <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
              <input
                className="input"
                type="datetime-local"
                value={blockStartsAt}
                onChange={(e) => setBlockStartsAt(e.target.value)}
                style={{ maxWidth: 190 }}
              />
              <select
                className="select"
                value={blockType}
                onChange={(event) => setBlockType(event.target.value as typeof blockType)}
                aria-label="Tipo de bloqueo"
              >
                <option value="block">Bloqueo</option>
                <option value="absence">Ausencia</option>
                <option value="vacation">Vacaciones</option>
              </select>
              <select
                className="select"
                value={blockSiteId}
                onChange={(event) => setBlockSiteId(event.target.value)}
                aria-label="Sede del bloqueo"
              >
                <option value="">Todas las sedes</option>
                {sites.items.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.name}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={blockProfessionalId}
                onChange={(event) => setBlockProfessionalId(event.target.value)}
                aria-label="Profesional del bloqueo"
              >
                <option value="">Todos los profesionales</option>
                {professionals.items.map((professional) => (
                  <option key={professional.id} value={professional.id}>
                    {professional.name}
                  </option>
                ))}
              </select>
              <select
                className="select"
                value={blockAppointmentTypeId}
                onChange={(event) => setBlockAppointmentTypeId(event.target.value)}
                aria-label="Tipo de cita del bloqueo"
              >
                <option value="">Todos los tipos de cita</option>
                {appointmentTypes.items.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
              <input
                className="input"
                type="datetime-local"
                value={blockEndsAt}
                onChange={(e) => setBlockEndsAt(e.target.value)}
                style={{ maxWidth: 190 }}
              />
              <input
                className="input"
                placeholder="Motivo"
                value={blockReason}
                onChange={(e) => setBlockReason(e.target.value)}
                style={{ maxWidth: 260 }}
              />
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={addBlock}
                disabled={savingBlock || !validBlockRange || !blockReason.trim()}
              >
                <Plus size={15} /> Bloquear
              </button>
            </div>
          ) : null}
          {canWrite && !validBlockRange ? (
            <div className="form-warning">La fecha final debe ser posterior a la inicial.</div>
          ) : null}
          {loading ? (
            <LoadingState />
          ) : error ? (
            <div className="banner">{error}</div>
          ) : blocks.items.length === 0 ? (
            <EmptyState label="Sin bloqueos de agenda" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Franja</th>
                  <th>Tipo</th>
                  <th>Motivo</th>
                  <th>Sede</th>
                  <th>Profesional</th>
                  <th>Tipo de cita</th>
                  <th>Estado</th>
                  {canWrite ? <th>Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {blocks.items.map((block) => (
                  <tr key={block.id}>
                    <td>
                      <strong className="small">{formatBlockRange(block.startsAt, block.endsAt)}</strong>
                    </td>
                    <td className="small muted">{blockTypeLabel(block.blockType)}</td>
                    <td className="small muted">{block.reason}</td>
                    <td className="small muted">
                      {block.siteId ? (siteById.get(block.siteId) ?? block.siteId) : "Todas"}
                    </td>
                    <td className="small muted">
                      {block.professionalId
                        ? (professionalById.get(block.professionalId) ?? block.professionalId)
                        : "Todos"}
                    </td>
                    <td className="small muted">
                      {block.appointmentTypeId
                        ? (typeById.get(block.appointmentTypeId) ?? block.appointmentTypeId)
                        : "Todos"}
                    </td>
                    <td>
                      <Pill tone={block.status === "active" ? "green" : "amber"}>{block.status}</Pill>
                    </td>
                    {canWrite ? (
                      <td>
                        <BlockStatusToggle path={blocksPath} block={block} onDone={blocks.reload} />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {section === "holidays" ? (
        <Card>
          <CardHead
            title={`Festivos (${holidays.items.length})`}
            trailing={<ReloadButton onClick={holidays.reload} />}
          />
          {canWrite ? (
            <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
              <input
                className="input"
                type="date"
                value={holidayDate}
                onChange={(e) => setHolidayDate(e.target.value)}
                style={{ maxWidth: 160 }}
              />
              <input
                className="input"
                placeholder="Nombre del festivo"
                value={holidayName}
                onChange={(e) => setHolidayName(e.target.value)}
                style={{ maxWidth: 260 }}
              />
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={addHoliday}
                disabled={savingHoliday || !holidayDate || !holidayName.trim()}
              >
                <Plus size={15} /> Agregar
              </button>
            </div>
          ) : null}
          {loading ? (
            <LoadingState />
          ) : error ? (
            <div className="banner">{error}</div>
          ) : holidays.items.length === 0 ? (
            <EmptyState label="Sin festivos configurados" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Nombre</th>
                  <th>Estado</th>
                  {canWrite ? <th>Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {holidays.items.map((holiday) => (
                  <tr key={holiday.id}>
                    <td className="small">{holiday.holidayDate}</td>
                    <td className="small muted">{holiday.name}</td>
                    <td>
                      <Pill tone={holiday.status === "active" ? "green" : "amber"}>{holiday.status}</Pill>
                    </td>
                    {canWrite ? (
                      <td>
                        <StatusToggle
                          path={holidaysPath}
                          id={holiday.id}
                          status={holiday.status}
                          onDone={holidays.reload}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {section === "exclusions" ? (
        <Card>
          <CardHead
            title={`Exclusiones por convenio (${exclusions.items.length})`}
            trailing={<ReloadButton onClick={exclusions.reload} />}
          />
          {canWrite ? (
            <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
              <select
                className="select"
                value={exclusionProfessionalId}
                onChange={(e) => setExclusionProfessionalId(e.target.value)}
              >
                {professionals.items.map((professional) => (
                  <option key={professional.id} value={professional.id}>
                    {professional.name}
                  </option>
                ))}
              </select>
              <select className="select" value={exclusionPayerId} onChange={(e) => setExclusionPayerId(e.target.value)}>
                {payers.items.map((payer) => (
                  <option key={payer.id} value={payer.id}>
                    {payer.name}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-primary btn-sm"
                type="button"
                onClick={addExclusion}
                disabled={savingExclusion || !exclusionProfessionalId || !exclusionPayerId}
              >
                <Plus size={15} /> Excluir
              </button>
            </div>
          ) : null}
          {loading ? (
            <LoadingState />
          ) : error ? (
            <div className="banner">{error}</div>
          ) : exclusions.items.length === 0 ? (
            <EmptyState label="Sin exclusiones por convenio" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Profesional</th>
                  <th>Convenio</th>
                  <th>Estado</th>
                  {canWrite ? <th>Acciones</th> : null}
                </tr>
              </thead>
              <tbody>
                {exclusions.items.map((exclusion) => (
                  <tr key={exclusion.id}>
                    <td className="small muted">
                      {professionalById.get(exclusion.professionalId) ?? exclusion.professionalId}
                    </td>
                    <td className="small muted">{payerById.get(exclusion.payerId) ?? exclusion.payerId}</td>
                    <td>
                      <Pill tone={exclusion.status === "active" ? "green" : "amber"}>{exclusion.status}</Pill>
                    </td>
                    {canWrite ? (
                      <td>
                        <StatusToggle
                          path={exclusionsPath}
                          id={exclusion.id}
                          status={exclusion.status}
                          onDone={exclusions.reload}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}
    </div>
  );
}

type ImportResource =
  | "professionals"
  | "professional-sites"
  | "professional-appointment-types"
  | "availability-rules"
  | "payer-exclusions"
  | "agenda-blocks";

const IMPORT_RESOURCES: Array<{ id: ImportResource; label: string }> = [
  { id: "professionals", label: "Profesionales" },
  { id: "professional-sites", label: "Profesional - sede" },
  { id: "professional-appointment-types", label: "Tipos por profesional" },
  { id: "availability-rules", label: "Horarios" },
  { id: "payer-exclusions", label: "Exclusiones por convenio" },
  { id: "agenda-blocks", label: "Bloqueos" }
];

function ImportExportTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const { logout } = useConsole();
  const inputRef = useRef<HTMLInputElement>(null);
  const [resource, setResource] = useState<ImportResource>("professionals");
  const [csv, setCsv] = useState("");
  const [filename, setFilename] = useState("");
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [preview, setPreview] = useState<ImportPreview>();
  const [busy, setBusy] = useState<"template" | "export" | "preview" | "apply">();
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<string>();

  const resetFile = (nextResource = resource) => {
    setResource(nextResource);
    setCsv("");
    setFilename("");
    setPreview(undefined);
    setResult(undefined);
    setError(undefined);
    setIdempotencyKey(crypto.randomUUID());
    if (inputRef.current) inputRef.current.value = "";
  };

  const download = async (kind: "template" | "export") => {
    setBusy(kind);
    setError(undefined);
    try {
      const suffix = kind === "template" ? `config/import/${resource}/template` : `config/export/${resource}`;
      const value = await api.text(tenantPath(tenantId, suffix));
      downloadCsv(value.content, value.filename ?? `${resource}-${kind}.csv`);
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  const selectFile = async (file: File | undefined) => {
    setPreview(undefined);
    setResult(undefined);
    setError(undefined);
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".csv")) {
      setError("Selecciona un archivo CSV.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("El archivo supera el limite de 2 MB.");
      return;
    }
    setFilename(file.name);
    setCsv(await file.text());
    setIdempotencyKey(crypto.randomUUID());
  };

  const runPreview = async () => {
    if (!csv) return;
    setBusy("preview");
    setError(undefined);
    setResult(undefined);
    try {
      const value = await api.post<unknown>(tenantPath(tenantId, `config/import/${resource}/preview`), { csv });
      setPreview(normalizeImportPreview(value));
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  const apply = async () => {
    if (!csv || !preview || preview.accepted === 0) return;
    setBusy("apply");
    setError(undefined);
    try {
      const value = await api.post<{ applied: number; idempotent: boolean }>(
        tenantPath(tenantId, `config/import/${resource}/apply`),
        { csv, idempotencyKey }
      );
      setResult(
        value.idempotent
          ? "La importacion ya habia sido aplicada; no se duplicaron registros."
          : `${value.applied} filas aplicadas correctamente.`
      );
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card>
        <CardHead title="Importar configuracion CSV" icon={<FileSpreadsheet size={18} />} />
        <div className="card-pad import-toolbar">
          <label className="field">
            <span>Tipo de configuracion</span>
            <select
              className="select"
              value={resource}
              onChange={(event) => resetFile(event.target.value as ImportResource)}
            >
              {IMPORT_RESOURCES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => void download("template")}
            disabled={busy === "template"}
          >
            <Download size={16} /> Plantilla CSV
          </button>
          <button
            className="btn btn-outline"
            type="button"
            onClick={() => void download("export")}
            disabled={busy === "export"}
          >
            <Download size={16} /> Exportar actual
          </button>
        </div>
        {canWrite ? (
          <div className="drop-row">
            <input
              ref={inputRef}
              className="visually-hidden"
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => void selectFile(event.target.files?.[0])}
            />
            <button className="btn btn-outline" type="button" onClick={() => inputRef.current?.click()}>
              <Upload size={16} /> Seleccionar CSV
            </button>
            <div className="col" style={{ flex: 1, minWidth: 0 }}>
              <strong className="small text-ellipsis">{filename || "Ningun archivo seleccionado"}</strong>
              <span className="tiny muted">Vista previa obligatoria antes de aplicar</span>
            </div>
            <button
              className="btn btn-primary"
              type="button"
              onClick={() => void runPreview()}
              disabled={!csv || busy === "preview"}
            >
              <FileSpreadsheet size={16} /> Validar
            </button>
          </div>
        ) : null}
        {error ? <div className="banner">{error}</div> : null}
        {result ? <div className="success-banner">{result}</div> : null}
      </Card>

      {preview ? (
        <Card>
          <CardHead
            title="Vista previa"
            trailing={
              <div className="row" style={{ flexWrap: "wrap" }}>
                <Pill tone="green">{preview.accepted} aceptadas</Pill>
                <Pill tone={preview.rejected > 0 ? "red" : "green"}>{preview.rejected} rechazadas</Pill>
              </div>
            }
          />
          {preview.rows.length === 0 ? (
            <EmptyState label="El archivo no contiene filas de datos" />
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Fila</th>
                    <th>Resultado</th>
                    <th>Detalle</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={`${row.rowNumber}-${row.accepted ? "ok" : "error"}`}>
                      <td className="small">{row.rowNumber}</td>
                      <td>
                        <Pill tone={row.accepted ? "green" : "red"}>{row.accepted ? "Aceptada" : "Rechazada"}</Pill>
                      </td>
                      <td className="small muted">{row.reason ?? summarizeImportValues(row.values)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {canWrite ? (
            <div className="card-actions">
              <span className="small muted">
                La aplicacion es transaccional e idempotente. Solo se aplican filas validadas.
              </span>
              <button
                className="btn btn-primary"
                type="button"
                onClick={() => void apply()}
                disabled={preview.accepted === 0 || busy === "apply" || Boolean(result)}
              >
                <Upload size={16} /> Aplicar importacion
              </button>
            </div>
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function summarizeImportValues(values?: Record<string, unknown>): string {
  if (!values) return "Fila valida";
  const ignored = new Set(["accepted", "row", "rowNumber", "values"]);
  const parts = Object.entries(values)
    .filter(([key, value]) => !ignored.has(key) && value != null && typeof value !== "object")
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${String(value)}`);
  return parts.join(" · ") || "Fila valida";
}

function downloadCsv(content: string, filename: string) {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function IntegrationsTab({ tenantId, isAdmin }: { tenantId: string; isAdmin: boolean }) {
  const { logout } = useConsole();
  const whatsappBase = `/v1/tenants/${encodeURIComponent(tenantId)}/integrations/whatsapp`;
  const { data, loading, error, refresh } = usePolling<WhatsAppIntegrationStatus>(
    `${whatsappBase}/status`,
    10_000,
    logout
  );
  const readiness = usePolling<SofiaReadiness>(tenantPath(tenantId, "sofia/readiness"), 15_000, logout);
  const [qr, setQr] = useState<WhatsAppQr>();
  const [action, setAction] = useState<"connect" | "qr" | "disconnect">();
  const [actionError, setActionError] = useState<string>();
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (data && data.state !== "qr_pending") setQr(undefined);
  }, [data]);

  const connect = async () => {
    if (!isAdmin) return;
    setAction("connect");
    setActionError(undefined);
    setQr(undefined);
    try {
      await api.post<{ status: WhatsAppIntegrationStatus }>(`${whatsappBase}/connect`, {});
      refresh();
      readiness.refresh();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(undefined);
    }
  };

  const loadQr = async () => {
    if (!isAdmin) return;
    setAction("qr");
    setActionError(undefined);
    try {
      const result = await api.get<WhatsAppQr>(`${whatsappBase}/qr`);
      if (!isSafeQrDataUrl(result.qrDataUrl)) {
        throw new Error("El proveedor devolvio un QR con formato invalido.");
      }
      setQr(result);
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(undefined);
    }
  };

  const disconnect = async () => {
    if (!isAdmin) return;
    setAction("disconnect");
    setActionError(undefined);
    try {
      await api.post<{ status: WhatsAppIntegrationStatus }>(`${whatsappBase}/disconnect`, {});
      setQr(undefined);
      setConfirmDisconnect(false);
      refresh();
      readiness.refresh();
    } catch (err) {
      if (err instanceof SessionExpiredError) logout();
      else setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setAction(undefined);
    }
  };

  const canConnect = data?.state === "disconnected" || data?.state === "degraded";
  const canShowQr = data?.state === "qr_pending";
  const showDisconnect = Boolean(data && data.state !== "disconnected");

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="channel-notice">
        <ShieldCheck size={18} aria-hidden="true" />
        <strong>{WHATSAPP_PRIVATE_CHANNEL_NOTICE}</strong>
      </div>

      <div className="integration-layout">
        <Card>
          <CardHead
            title="WhatsApp de prueba"
            icon={<MessageCircle size={18} />}
            trailing={
              <button className="icon-btn" type="button" onClick={refresh} aria-label="Actualizar estado de WhatsApp">
                <RefreshCw size={16} />
              </button>
            }
          />
          {error ? (
            <div className="banner">{error}</div>
          ) : !data && loading ? (
            <LoadingState label="Consultando canal..." />
          ) : data ? (
            <>
              <div className="card-pad integration-status-grid">
                <IntegrationDatum
                  label="Estado"
                  value={whatsappStateLabel(data.state)}
                  tone={whatsappStateTone(data.state)}
                />
                <IntegrationDatum label="Proveedor" value="WhatsApp Web de prueba" />
                <IntegrationDatum label="Identidad" value={data.phoneMasked ?? "Identidad de canal pendiente"} />
                <IntegrationDatum
                  label="Ultima actividad"
                  value={data.lastActivityAt ? formatIntegrationDate(data.lastActivityAt) : "Sin actividad registrada"}
                />
                <IntegrationDatum
                  label="Sesion recuperable"
                  value={data.sessionRestorable ? "Disponible" : "No disponible"}
                  tone={data.sessionRestorable ? "green" : "amber"}
                />
                <IntegrationDatum
                  label="Vencimiento QR"
                  value={data.qrExpiresAt ? formatIntegrationDate(data.qrExpiresAt) : "Sin QR activo"}
                />
              </div>
              {data.lastError ? <div className="banner">{data.lastError}</div> : null}
              {actionError ? <div className="banner">{actionError}</div> : null}
              {isAdmin ? (
                <div className="card-actions integration-actions">
                  {canConnect ? (
                    <button
                      className="btn btn-primary"
                      type="button"
                      onClick={() => void connect()}
                      disabled={Boolean(action)}
                    >
                      <MessageCircle size={16} /> {action === "connect" ? "Conectando..." : "Conectar"}
                    </button>
                  ) : null}
                  {canShowQr ? (
                    <button
                      className="btn btn-outline"
                      type="button"
                      onClick={() => void loadQr()}
                      disabled={Boolean(action)}
                    >
                      <QrCode size={16} /> {action === "qr" ? "Cargando QR..." : "Mostrar QR"}
                    </button>
                  ) : null}
                  {showDisconnect && !confirmDisconnect ? (
                    <button
                      className="btn btn-outline danger-action"
                      type="button"
                      onClick={() => setConfirmDisconnect(true)}
                      disabled={Boolean(action)}
                    >
                      <Unplug size={16} /> Desconectar
                    </button>
                  ) : null}
                  {showDisconnect && confirmDisconnect ? (
                    <div className="row integration-confirm">
                      <span className="small muted">Confirmar desconexion</span>
                      <button
                        className="btn btn-outline btn-sm"
                        type="button"
                        onClick={() => setConfirmDisconnect(false)}
                      >
                        Volver
                      </button>
                      <button
                        className="btn btn-primary btn-sm"
                        type="button"
                        onClick={() => void disconnect()}
                        disabled={Boolean(action)}
                      >
                        <Unplug size={15} /> {action === "disconnect" ? "Desconectando..." : "Confirmar"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="card-actions">
                  <span className="small muted">Operación disponible únicamente para administradores.</span>
                </div>
              )}
            </>
          ) : (
            <EmptyState label="Estado de WhatsApp no disponible" />
          )}
        </Card>

        <Card>
          <CardHead
            title="Readiness de SOFIA"
            icon={<ShieldCheck size={18} />}
            trailing={
              <button
                className="icon-btn"
                type="button"
                onClick={readiness.refresh}
                aria-label="Actualizar readiness de SOFIA"
              >
                <RefreshCw size={16} />
              </button>
            }
          />
          {readiness.error ? (
            <div className="banner">{readiness.error}</div>
          ) : !readiness.data && readiness.loading ? (
            <LoadingState label="Consultando readiness..." />
          ) : readiness.data ? (
            <div className="card-pad col" style={{ gap: 14 }}>
              <div className="row between">
                <span className="small muted">Estado operativo</span>
                <Pill tone={readiness.data.status === "ready" ? "green" : "amber"}>
                  {readiness.data.status === "ready"
                    ? "Lista"
                    : readiness.data.status === "degraded"
                      ? "Degradada"
                      : "No lista"}
                </Pill>
              </div>
              <div className="row between">
                <span className="small muted">Recibir mensajes</span>
                <Pill tone={readiness.data.canReceiveMessages ? "green" : "amber"}>
                  {readiness.data.canReceiveMessages ? "Disponible" : "No disponible"}
                </Pill>
              </div>
              <div className="row between">
                <span className="small muted">Agendar citas</span>
                <Pill tone={readiness.data.canBookAppointments ? "green" : "amber"}>
                  {readiness.data.canBookAppointments ? "Disponible" : "No disponible"}
                </Pill>
              </div>
              <div className="row between">
                <span className="small muted">Comprobado</span>
                <strong className="small">{formatIntegrationDate(readiness.data.checkedAt)}</strong>
              </div>
              {readiness.data.dependencies.map((dependency) => (
                <div className="row between integration-dependency" key={dependency.name}>
                  <span className="small muted">{sofiaDependencyLabel(dependency.name)}</span>
                  <Pill tone={dependency.status === "ok" ? "green" : dependency.status === "down" ? "red" : "amber"}>
                    {dependency.status === "ok"
                      ? "Lista"
                      : dependency.status === "down"
                        ? "No disponible"
                        : "Degradada"}
                  </Pill>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState label="Readiness no disponible" />
          )}
        </Card>
      </div>

      {isAdmin && qr ? (
        <Card>
          <CardHead
            title="Vinculacion por QR"
            icon={<QrCode size={18} />}
            trailing={<Pill tone={qr.state === "ready" ? "green" : "amber"}>{whatsappStateLabel(qr.state)}</Pill>}
          />
          <div className="qr-panel">
            {qr.qrDataUrl ? <img src={qr.qrDataUrl} alt="Codigo QR temporal de vinculacion" /> : null}
            <div className="col" style={{ gap: 6 }}>
              <strong className="small">QR temporal</strong>
              <span className="small muted">
                {qr.qrExpiresAt ? `Vence ${formatIntegrationDate(qr.qrExpiresAt)}` : "Sin vencimiento informado"}
              </span>
              <button className="btn btn-outline btn-sm" type="button" onClick={() => setQr(undefined)}>
                Ocultar QR
              </button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function IntegrationDatum({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: "green" | "red" | "amber" | "blue";
}) {
  return (
    <div className="integration-datum">
      <span>{label}</span>
      {tone ? <Pill tone={tone}>{value}</Pill> : <strong>{value}</strong>}
    </div>
  );
}

function sofiaDependencyLabel(name: string): string {
  const labels: Record<string, string> = {
    channel: "Canal WhatsApp",
    llm: "Motor de SOFIA",
    prompt_flow: "Flujo conversacional",
    agenda: "Agenda"
  };
  return labels[name] ?? name.replaceAll("_", " ");
}

function formatIntegrationDate(value: string): string {
  return new Date(value).toLocaleString("es-CO", {
    timeZone: "America/Bogota",
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function OperatorsTab() {
  const { tenants } = useConsole();
  const { items, loading, error, reload } = useCatalog<OperatorListItem>("/v1/identity/operators");
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"coordinator" | "advisor" | "auditor">("advisor");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (!email || !displayName || password.length < 8) return;
    setSaving(true);
    try {
      await api.post("/v1/identity/operators", {
        email,
        displayName,
        password,
        role,
        tenantIds: tenants.map((tenant) => tenant.id)
      });
      setEmail("");
      setDisplayName("");
      setPassword("");
      reload();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHead title={`Operadores (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
      <div className="card-pad row" style={{ gap: 8, flexWrap: "wrap", borderBottom: `1px solid ${LINE}` }}>
        <input
          className="input"
          placeholder="Correo"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ maxWidth: 220 }}
        />
        <input
          className="input"
          placeholder="Nombre visible"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          style={{ maxWidth: 190 }}
        />
        <input
          className="input"
          placeholder="Contrasena inicial"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ maxWidth: 180 }}
        />
        <select className="select" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
          <option value="coordinator">Coordinador</option>
          <option value="advisor">Asesor</option>
          <option value="auditor">Auditor</option>
        </select>
        <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving}>
          <Plus size={15} /> Crear
        </button>
      </div>
      {loading ? (
        <LoadingState />
      ) : error ? (
        <div className="banner">{error}</div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Operador</th>
              <th>Rol</th>
              <th>Estado</th>
              <th>Tenants</th>
            </tr>
          </thead>
          <tbody>
            {items.map((operator) => (
              <tr key={operator.id}>
                <td>
                  <strong className="small">{operator.displayName}</strong>
                  <div className="tiny muted">{operator.email}</div>
                </td>
                <td>
                  <Pill>{operator.role}</Pill>
                </td>
                <td>
                  <Pill tone={operator.status === "active" ? "green" : "amber"}>{operator.status}</Pill>
                </td>
                <td className="small muted">{operator.tenantIds.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

interface PlatformHealth {
  status: string;
  services: Array<{ service: string; status: string; version: string }>;
}

function PlatformTab() {
  const { logout } = useConsole();
  const [health, setHealth] = useState<PlatformHealth>();
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .get<PlatformHealth>("/v1/platform/health")
      .then(setHealth)
      .catch((err) => {
        if (err instanceof SessionExpiredError) logout();
      })
      .finally(() => setLoading(false));
  }, [logout]);

  useEffect(() => reload(), [reload]);

  return (
    <Card>
      <CardHead
        title="Estado de la plataforma"
        icon={<Server size={18} />}
        trailing={<ReloadButton onClick={reload} />}
      />
      {loading ? (
        <LoadingState />
      ) : !health ? (
        <EmptyState label="Sin datos de plataforma" />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Servicio</th>
              <th>Version</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {health.services.map((service) => (
              <tr key={service.service}>
                <td className="small">{service.service}</td>
                <td className="small muted">{service.version}</td>
                <td>
                  <Pill tone={service.status === "ok" ? "green" : service.status === "down" ? "red" : "amber"}>
                    {service.status}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function StatusToggle({
  path,
  id,
  status,
  onDone
}: {
  path: string;
  id: string;
  status: "active" | "paused";
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);
  const nextStatus = status === "active" ? "paused" : "active";

  const toggle = async () => {
    setSaving(true);
    try {
      await api.patch(`${path}/${id}`, { status: nextStatus });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <button className="btn btn-outline btn-sm" type="button" onClick={toggle} disabled={saving}>
      {nextStatus === "paused" ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
      {nextStatus === "paused" ? "Pausar" : "Activar"}
    </button>
  );
}

function BlockStatusToggle({ path, block, onDone }: { path: string; block: PulsoIrisAgendaBlock; onDone: () => void }) {
  const [saving, setSaving] = useState(false);
  const nextStatus = block.status === "active" ? "cancelled" : "active";

  const toggle = async () => {
    setSaving(true);
    try {
      await api.patch(`${path}/${block.id}`, { status: nextStatus });
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <button className="btn btn-outline btn-sm" type="button" onClick={toggle} disabled={saving}>
      {nextStatus === "cancelled" ? <PauseCircle size={15} /> : <PlayCircle size={15} />}
      {nextStatus === "cancelled" ? "Cancelar" : "Activar"}
    </button>
  );
}

function weekdayLabel(value: number): string {
  return WEEKDAYS.find((day) => day.value === value)?.label ?? String(value);
}

function blockTypeLabel(value: "block" | "absence" | "vacation"): string {
  if (value === "absence") return "Ausencia";
  if (value === "vacation") return "Vacaciones";
  return "Bloqueo";
}

function shortTime(value: string): string {
  return value.slice(0, 5);
}

function defaultLocalDateTime(hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatBlockRange(startsAt: string, endsAt: string): string {
  const start = new Date(startsAt);
  const end = new Date(endsAt);
  return `${start.toLocaleDateString("es-CO", {
    month: "short",
    day: "2-digit"
  })} ${start.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit"
  })} - ${end.toLocaleTimeString("es-CO", {
    hour: "2-digit",
    minute: "2-digit"
  })}`;
}

function ReloadButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" onClick={onClick} aria-label="Actualizar">
      <RefreshCw size={16} />
    </button>
  );
}
