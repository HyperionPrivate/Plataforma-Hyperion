import { CalendarClock, PauseCircle, PlayCircle, Plus, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  OperatorListItem,
  PulsoIrisAvailabilityRule,
  PulsoIrisAppointmentType,
  PulsoIrisPayer,
  PulsoIrisProfessional,
  PulsoIrisSite
} from "@hyperion/contracts";
import { Layout } from "../components/Layout.js";
import { Card, CardHead, EmptyState, LoadingState, Pill } from "../components/ui.js";
import { api, SessionExpiredError } from "../lib/api.js";
import { tenantPath, useConsole } from "../lib/context.js";
import { LINE } from "../lib/format.js";
import { can } from "../lib/rbac.js";

type Tab = "sites" | "professionals" | "payers" | "types" | "availability" | "operators" | "platform";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "sites", label: "Sedes" },
  { id: "professionals", label: "Profesionales" },
  { id: "payers", label: "Convenios" },
  { id: "types", label: "Tipos de cita" },
  { id: "availability", label: "Disponibilidad" },
  { id: "operators", label: "Operadores" },
  { id: "platform", label: "Estado de plataforma" }
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
  const [tab, setTab] = useState<Tab>("sites");
  const visibleTabs = TABS.filter((item) => item.id !== "operators" || can(session.operator.role, "manage:operators"));
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

      {tab === "sites" ? <SitesTab tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
      {tab === "professionals" ? <ProfessionalsTab tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
      {tab === "payers" ? <PayersTab tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
      {tab === "types" ? <TypesTab tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
      {tab === "availability" ? <AvailabilityTab tenantId={tenant.id} canWrite={canWriteConfig} /> : null}
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
  const [saving, setSaving] = useState(false);

  const add = async () => {
    if (name.trim().length < 2) return;
    setSaving(true);
    try {
      await api.post(path, { name, professionalType: type, subspecialty: subspecialty || undefined });
      setName("");
      setSubspecialty("");
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
        <EmptyState label="Sin profesionales. Agrega o carga el dataset demo." />
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Tipo</th>
              <th>Subespecialidad</th>
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
            IA
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

function AvailabilityTab({ tenantId, canWrite }: { tenantId: string; canWrite: boolean }) {
  const rulesPath = tenantPath(tenantId, "config/availability-rules");
  const sitesPath = tenantPath(tenantId, "config/sites");
  const professionalsPath = tenantPath(tenantId, "config/professionals");
  const typesPath = tenantPath(tenantId, "config/appointment-types");
  const rules = useCatalog<PulsoIrisAvailabilityRule>(rulesPath);
  const sites = useCatalog<PulsoIrisSite>(sitesPath);
  const professionals = useCatalog<PulsoIrisProfessional>(professionalsPath);
  const appointmentTypes = useCatalog<PulsoIrisAppointmentType>(typesPath);
  const [siteId, setSiteId] = useState("");
  const [professionalId, setProfessionalId] = useState("");
  const [appointmentTypeId, setAppointmentTypeId] = useState("");
  const [weekday, setWeekday] = useState("1");
  const [startsAt, setStartsAt] = useState("08:00");
  const [endsAt, setEndsAt] = useState("12:00");
  const [slotDurationMin, setSlotDurationMin] = useState("20");
  const [capacity, setCapacity] = useState("1");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!siteId && sites.items[0]) setSiteId(sites.items[0].id);
    if (!professionalId && professionals.items[0]) setProfessionalId(professionals.items[0].id);
    if (!appointmentTypeId && appointmentTypes.items[0]) setAppointmentTypeId(appointmentTypes.items[0].id);
  }, [appointmentTypeId, appointmentTypes.items, professionalId, professionals.items, siteId, sites.items]);

  const siteById = new Map(sites.items.map((site) => [site.id, site.name]));
  const professionalById = new Map(professionals.items.map((professional) => [professional.id, professional.name]));
  const typeById = new Map(appointmentTypes.items.map((type) => [type.id, type.name]));

  const add = async () => {
    if (!siteId || !professionalId || !appointmentTypeId) return;
    setSaving(true);
    try {
      await api.post(rulesPath, {
        siteId,
        professionalId,
        appointmentTypeId,
        weekday: Number(weekday),
        startsAt,
        endsAt,
        slotDurationMin: Number(slotDurationMin),
        capacity: Number(capacity)
      });
      rules.reload();
    } finally {
      setSaving(false);
    }
  };

  const loading = rules.loading || sites.loading || professionals.loading || appointmentTypes.loading;
  const error = rules.error ?? sites.error ?? professionals.error ?? appointmentTypes.error;
  const canCreate = canWrite && siteId && professionalId && appointmentTypeId;

  return (
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
          <select className="select" value={appointmentTypeId} onChange={(e) => setAppointmentTypeId(e.target.value)}>
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
          <button className="btn btn-primary btn-sm" type="button" onClick={add} disabled={saving || !canCreate}>
            <Plus size={15} /> Agregar
          </button>
        </div>
      ) : null}
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
  );
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

function weekdayLabel(value: number): string {
  return WEEKDAYS.find((day) => day.value === value)?.label ?? String(value);
}

function shortTime(value: string): string {
  return value.slice(0, 5);
}

function ReloadButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" onClick={onClick} aria-label="Actualizar">
      <RefreshCw size={16} />
    </button>
  );
}
