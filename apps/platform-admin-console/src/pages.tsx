import type { PlatformRole } from "@hyperion/platform-contracts";
import { platformControlTenantId } from "@hyperion/platform-contracts/platform-control";
import type { ProductCatalog } from "@hyperion/platform-contracts/product-catalog";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Layout } from "./components/Layout.js";
import {
  isProtectedControlGrant,
  parseUniqueValues,
  platformGrantPath,
  wouldDowngradeOwnControlGrant
} from "./lib/admin-model.js";
import { ApiError, api } from "./lib/api.js";
import { useAdmin } from "./lib/context.js";

interface TenantRow {
  id: string;
  slug: string;
  display_name: string;
  status: string;
}

interface OperatorListItem {
  id: string;
  email: string;
  displayName: string;
  role: PlatformRole;
  status: "active" | "disabled";
  tenantIds: string[];
  createdAt?: string;
}

interface GrantRow {
  operatorId: string;
  tenantId: string;
  productId: string;
  roles: string[];
  capabilities: string[];
  active: boolean;
}

interface MutationState {
  busy: boolean;
  message?: string;
  error?: string;
}

const PLATFORM_ROLES: readonly PlatformRole[] = ["admin", "coordinator", "advisor", "auditor"];

function useResource<T>(path: string) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [unavailable, setUnavailable] = useState(false);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setError(undefined);
    setUnavailable(false);
    api
      .get<T>(path)
      .then((value) => {
        if (active) setData(value);
      })
      .catch((reason) => {
        if (!active) return;
        setUnavailable(reason instanceof ApiError && reason.status === 404);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [path, revision]);

  return { data, error, unavailable, reload };
}

function State({
  data,
  error,
  unavailable,
  children
}: {
  data: unknown;
  error?: string;
  unavailable?: boolean;
  children: ReactNode;
}) {
  if (unavailable) return <div className="notice">Esta capacidad aún no está publicada por el BFF de plataforma.</div>;
  if (error)
    return (
      <div className="alert" role="alert">
        {error}
      </div>
    );
  if (!data)
    return (
      <div className="notice" aria-live="polite">
        Cargando…
      </div>
    );
  return <>{children}</>;
}

function MutationFeedback({ state }: { state: MutationState }) {
  return (
    <div className="mutation-feedback" aria-live="polite" aria-atomic="true">
      {state.error ? (
        <span className="form-error" role="alert">
          {state.error}
        </span>
      ) : state.message ? (
        <span className="form-success">{state.message}</span>
      ) : null}
    </div>
  );
}

function CreateOperatorForm({ tenants, onCreated }: { tenants: TenantRow[]; onCreated: () => void }) {
  const [state, setState] = useState<MutationState>({ busy: false });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setState({ busy: true });
    try {
      await api.post<OperatorListItem>("/v1/identity/operators", {
        email: readFormString(values, "email"),
        displayName: readFormString(values, "displayName"),
        password: readFormString(values, "password"),
        role: readFormString(values, "role"),
        tenantIds: values.getAll("tenantIds").map(String)
      });
      form.reset();
      setState({ busy: false, message: "Usuario creado." });
      onCreated();
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <details className="admin-panel">
      <summary>Crear usuario</summary>
      <form className="admin-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Nombre visible <span aria-hidden="true">*</span>
            <input name="displayName" minLength={2} required autoComplete="name" />
          </label>
          <label>
            Correo <span aria-hidden="true">*</span>
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Contraseña inicial <span aria-hidden="true">*</span>
            <input name="password" type="password" minLength={8} required autoComplete="new-password" />
          </label>
          <label>
            Rol de plataforma <span aria-hidden="true">*</span>
            <select name="role" defaultValue="advisor" required>
              {PLATFORM_ROLES.map((role) => (
                <option key={role} value={role}>
                  {role}
                </option>
              ))}
            </select>
          </label>
        </div>
        <TenantMemberships tenants={tenants} />
        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={state.busy}>
            {state.busy ? "Creando…" : "Crear usuario"}
          </button>
          <MutationFeedback state={state} />
        </div>
      </form>
    </details>
  );
}

function TenantMemberships({ tenants, selected = [] }: { tenants: TenantRow[]; selected?: string[] }) {
  return (
    <fieldset className="checkbox-group">
      <legend>Membresías de tenant</legend>
      {tenants.length === 0 ? (
        <span className="field-help">No hay tenants seleccionables; el usuario se creará sin membresías.</span>
      ) : (
        tenants.map((tenant) => (
          <label key={tenant.id}>
            <input name="tenantIds" type="checkbox" value={tenant.id} defaultChecked={selected.includes(tenant.id)} />
            <span>
              {tenant.display_name} <small>{tenant.slug}</small>
            </span>
          </label>
        ))
      )}
    </fieldset>
  );
}

function OperatorEditor({
  operator,
  tenants,
  currentOperatorId,
  onUpdated
}: {
  operator: OperatorListItem;
  tenants?: TenantRow[];
  currentOperatorId: string;
  onUpdated: () => void;
}) {
  const [state, setState] = useState<MutationState>({ busy: false });
  const isCurrentOperator = operator.id === currentOperatorId;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = readFormString(values, "password");
    setState({ busy: true });
    try {
      await api.patch<OperatorListItem>(`/v1/identity/operators/${encodeURIComponent(operator.id)}`, {
        displayName: readFormString(values, "displayName"),
        role: readFormString(values, "role"),
        status: isCurrentOperator ? undefined : readFormString(values, "status"),
        password: password || undefined,
        tenantIds: tenants ? values.getAll("tenantIds").map(String) : undefined
      });
      setState({ busy: false, message: "Usuario actualizado." });
      onUpdated();
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return (
    <article className="card">
      <strong>{operator.displayName}</strong>
      <span>{operator.email}</span>
      <span className="tag">
        {operator.role} · {operator.status}
      </span>
      <details className="inline-editor">
        <summary>Editar</summary>
        <form className="admin-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              Nombre visible
              <input name="displayName" minLength={2} defaultValue={operator.displayName} required />
            </label>
            <label>
              Rol
              <select name="role" defaultValue={operator.role}>
                {PLATFORM_ROLES.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Estado
              <select name="status" defaultValue={operator.status} disabled={isCurrentOperator}>
                <option value="active">active</option>
                <option value="disabled">disabled</option>
              </select>
              {isCurrentOperator ? (
                <small className="field-help">
                  No puedes deshabilitar la cuenta con la que administras esta sesión.
                </small>
              ) : null}
            </label>
            <label>
              Nueva contraseña
              <input name="password" type="password" minLength={8} autoComplete="new-password" />
              <small className="field-help">Déjala vacía para conservar la actual.</small>
            </label>
          </div>
          {tenants ? <TenantMemberships tenants={tenants} selected={operator.tenantIds} /> : null}
          <div className="form-actions">
            <button className="primary-button" type="submit" disabled={state.busy}>
              {state.busy ? "Guardando…" : "Guardar cambios"}
            </button>
            <MutationFeedback state={state} />
          </div>
        </form>
      </details>
    </article>
  );
}

export function OperatorsPage() {
  const { session } = useAdmin();
  const operators = useResource<OperatorListItem[]>("/v1/identity/operators");
  const tenants = useResource<TenantRow[]>("/v1/tenants");
  return (
    <Layout title="Usuarios">
      {tenants.data ? (
        <CreateOperatorForm tenants={tenants.data} onCreated={operators.reload} />
      ) : (
        <div className="notice">
          La creación se habilitará cuando el inventario de tenants esté disponible; así se evitan usuarios sin
          membresías por una carga incompleta.
        </div>
      )}
      {tenants.error ? (
        <div className="alert" role="alert">
          No se pudo cargar el inventario de tenants: {tenants.error}
        </div>
      ) : null}
      <State {...operators}>
        <section className="grid" aria-label="Usuarios de plataforma">
          {operators.data?.map((operator) => (
            <OperatorEditor
              key={`${operator.id}:${operator.displayName}:${operator.status}:${operator.tenantIds.join(",")}`}
              operator={operator}
              tenants={tenants.data}
              currentOperatorId={session.operator.id}
              onUpdated={operators.reload}
            />
          ))}
        </section>
      </State>
    </Layout>
  );
}

export function TenantsPage() {
  const resource = useResource<TenantRow[]>("/v1/tenants");
  return (
    <Layout title="Tenants">
      <div className="notice">
        Inventario de solo lectura. <code>tenant-service</code> aún no publica una API de alta o edición; HYP-FED-001
        rastrea ese gap. Esta consola no escribe tablas de tenants directamente.
      </div>
      <State {...resource}>
        <section className="grid" aria-label="Tenants aprovisionados">
          {resource.data?.map((tenant) => (
            <article className="card" key={tenant.id}>
              <strong>{tenant.display_name}</strong>
              <span>
                {tenant.slug} · {tenant.status}
              </span>
              <code>{tenant.id}</code>
            </article>
          ))}
        </section>
      </State>
    </Layout>
  );
}

function GrantForm({
  operators,
  tenants,
  catalog,
  currentOperatorId,
  onSaved
}: {
  operators: OperatorListItem[];
  tenants: TenantRow[];
  catalog: ProductCatalog;
  currentOperatorId: string;
  onSaved: () => void;
}) {
  const [state, setState] = useState<MutationState>({ busy: false });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const grant = {
      operatorId: readFormString(values, "operatorId"),
      tenantId: readFormString(values, "tenantId"),
      productId: readFormString(values, "productId")
    };
    const roles = parseUniqueValues(readFormString(values, "roles"));
    const capabilities = parseUniqueValues(readFormString(values, "capabilities"));
    if (roles.length === 0 || capabilities.length === 0) {
      setState({ busy: false, error: "Declara al menos un rol y una capacidad explícitos." });
      return;
    }
    if (grant.productId === "PLATFORM" && grant.tenantId !== platformControlTenantId) {
      setState({ busy: false, error: "PLATFORM sólo puede asignarse al tenant reservado de control." });
      return;
    }
    if (wouldDowngradeOwnControlGrant(currentOperatorId, grant, roles, capabilities)) {
      setState({ busy: false, error: "No puedes retirar tu propia autoridad de recuperación de plataforma." });
      return;
    }
    setState({ busy: true });
    try {
      await api.put<GrantRow>(platformGrantPath(grant), { roles, capabilities, active: true });
      setState({ busy: false, message: "Grant guardado." });
      onSaved();
    } catch (error) {
      setState({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const ready = operators.length > 0 && tenants.length > 0 && catalog.items.length > 0;
  return (
    <details className="admin-panel">
      <summary>Asignar o actualizar grant</summary>
      <form className="admin-form" onSubmit={submit}>
        <div className="form-grid">
          <label>
            Usuario
            <select name="operatorId" required disabled={!ready}>
              {operators.map((operator) => (
                <option key={operator.id} value={operator.id}>
                  {operator.displayName} · {operator.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tenant
            <select name="tenantId" required disabled={!ready}>
              {tenants.map((tenant) => (
                <option key={tenant.id} value={tenant.id}>
                  {tenant.display_name} · {tenant.slug}
                </option>
              ))}
            </select>
          </label>
          <label>
            Producto
            <select name="productId" required disabled={!ready}>
              {catalog.items.map((product) => (
                <option key={product.productId} value={product.productId}>
                  {product.name} · {product.productId}
                </option>
              ))}
            </select>
          </label>
          <label>
            Roles
            <input name="roles" required placeholder="admin, auditor" aria-describedby="grant-values-help" />
          </label>
          <label>
            Capacidades
            <input
              name="capabilities"
              required
              placeholder="producto:lectura, producto:administracion"
              aria-describedby="grant-values-help"
            />
          </label>
        </div>
        <p className="field-help" id="grant-values-help">
          Valores explícitos separados por comas. La consola no inventa presets de autorización.
        </p>
        <div className="form-actions">
          <button className="primary-button" type="submit" disabled={state.busy || !ready}>
            {state.busy ? "Guardando…" : "Guardar grant"}
          </button>
          <MutationFeedback state={state} />
        </div>
      </form>
    </details>
  );
}

export function GrantsPage() {
  const { session } = useAdmin();
  const grants = useResource<GrantRow[]>("/v1/platform/grants");
  const operators = useResource<OperatorListItem[]>("/v1/identity/operators");
  const tenants = useResource<TenantRow[]>("/v1/tenants");
  const catalog = useResource<ProductCatalog>("/v1/platform/catalog");
  const [mutation, setMutation] = useState<MutationState>({ busy: false });

  async function revoke(grant: GrantRow) {
    if (isProtectedControlGrant(session.operator.id, grant) || !grant.active) return;
    if (!window.confirm(`Revocar ${grant.productId} para ${grant.operatorId}?`)) return;
    setMutation({ busy: true });
    try {
      await api.delete(platformGrantPath(grant));
      setMutation({ busy: false, message: "Grant revocado." });
      grants.reload();
    } catch (error) {
      setMutation({ busy: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  const operatorNames = new Map(operators.data?.map((operator) => [operator.id, operator.displayName]));
  return (
    <Layout title="Grants">
      <p className="lead">Autorización normativa: tenant × producto × roles/capacidades.</p>
      {operators.data && tenants.data && catalog.data ? (
        <GrantForm
          operators={operators.data}
          tenants={tenants.data}
          catalog={catalog.data}
          currentOperatorId={session.operator.id}
          onSaved={grants.reload}
        />
      ) : (
        <div className="notice">Cargando los inventarios necesarios para administrar grants…</div>
      )}
      <MutationFeedback state={mutation} />
      <State {...grants}>
        <section className="grid" aria-label="Grants de producto">
          {grants.data?.map((grant) => {
            const protectedGrant = isProtectedControlGrant(session.operator.id, grant);
            return (
              <article className="card" key={`${grant.operatorId}:${grant.tenantId}:${grant.productId}`}>
                <strong>{grant.productId}</strong>
                <span>Usuario: {operatorNames.get(grant.operatorId) ?? grant.operatorId}</span>
                <span>Tenant: {grant.tenantId}</span>
                <span>Roles: {grant.roles.join(", ")}</span>
                <span>Capacidades: {grant.capabilities.join(", ")}</span>
                <span className="tag">{grant.active ? "active" : "revoked"}</span>
                <button
                  className="danger-button"
                  type="button"
                  disabled={!grant.active || protectedGrant || mutation.busy}
                  aria-describedby={protectedGrant ? `protected-${grant.operatorId}` : undefined}
                  onClick={() => void revoke(grant)}
                >
                  Revocar
                </button>
                {protectedGrant ? (
                  <small className="field-help" id={`protected-${grant.operatorId}`}>
                    No puedes revocar desde la UI tu propio grant de control.
                  </small>
                ) : null}
              </article>
            );
          })}
        </section>
      </State>
    </Layout>
  );
}

export function CatalogPage() {
  const resource = useResource<ProductCatalog>("/v1/platform/catalog");
  return (
    <Layout title="Catálogo">
      <State {...resource}>
        <p className="lead">
          Catálogo v{resource.data?.catalogVersion} · esquema {resource.data?.schemaVersion} · actualizado{" "}
          {resource.data?.updatedAt}
        </p>
        <section className="grid" aria-label="Catálogo versionado de productos">
          {resource.data?.items.map((product) => (
            <article className="card" key={product.productId}>
              <strong>{product.name}</strong>
              <span>
                {product.productId} · {product.status}
              </span>
              <span>
                Celda: {product.cell} · {product.kind}
              </span>
              <code>{product.owner}</code>
            </article>
          ))}
        </section>
      </State>
    </Layout>
  );
}

export function ForbiddenPage() {
  return (
    <main className="centered" id="main-content">
      <div className="error-code">403</div>
      <h1>Acceso no autorizado</h1>
      <p>Tu sesión no tiene el grant de administración de plataforma.</p>
    </main>
  );
}

export function NotFoundPage() {
  return (
    <main className="centered" id="main-content">
      <div className="error-code">404</div>
      <h1>Ruta inexistente</h1>
      <p>Esta consola no contiene flujos de producto.</p>
      <a href="/operators">Volver a usuarios</a>
    </main>
  );
}

function readFormString(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === "string" ? value.trim() : "";
}
