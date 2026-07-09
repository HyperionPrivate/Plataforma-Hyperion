import { Plus, RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
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

type Tab = "sites" | "professionals" | "payers" | "types" | "platform";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "sites", label: "Sedes" },
  { id: "professionals", label: "Profesionales" },
  { id: "payers", label: "Convenios" },
  { id: "types", label: "Tipos de cita" },
  { id: "platform", label: "Estado de plataforma" }
];

export function ConfigPage() {
  const { tenant } = useConsole();
  const [tab, setTab] = useState<Tab>("sites");

  return (
    <Layout title="Configuracion" subtitle={`Catalogo operativo de ${tenant.displayName}`}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        {TABS.map((item) => (
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

      {tab === "sites" ? <SitesTab tenantId={tenant.id} /> : null}
      {tab === "professionals" ? <ProfessionalsTab tenantId={tenant.id} /> : null}
      {tab === "payers" ? <PayersTab tenantId={tenant.id} /> : null}
      {tab === "types" ? <TypesTab tenantId={tenant.id} /> : null}
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

function SitesTab({ tenantId }: { tenantId: string }) {
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ProfessionalsTab({ tenantId }: { tenantId: string }) {
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function PayersTab({ tenantId }: { tenantId: string }) {
  const path = tenantPath(tenantId, "config/payers");
  const { items, loading, error, reload } = useCatalog<PulsoIrisPayer>(path);
  const groupLabels: Record<string, string> = {
    eps: "EPS",
    private_prepaid: "Prepagada",
    policy: "Poliza",
    particular: "Particular",
    other: "Otro"
  };

  return (
    <Card>
      <CardHead title={`Convenios (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function TypesTab({ tenantId }: { tenantId: string }) {
  const path = tenantPath(tenantId, "config/appointment-types");
  const { items, loading, error, reload } = useCatalog<PulsoIrisAppointmentType>(path);
  const categoryLabels: Record<string, string> = {
    consulta: "Consulta",
    ayuda_dx: "Ayuda diagnostica",
    valoracion_qx: "Valoracion Qx",
    control_post: "Control post"
  };

  return (
    <Card>
      <CardHead title={`Tipos de cita (${items.length})`} trailing={<ReloadButton onClick={reload} />} />
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

function ReloadButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="icon-btn" type="button" onClick={onClick} aria-label="Actualizar">
      <RefreshCw size={16} />
    </button>
  );
}
