import type { DatabaseExecutor } from "@hyperion/database";

/**
 * Materializes PULSO-owned defaults on first authorized product use.
 * PostgreSQL's primary key plus ON CONFLICT makes concurrent/repeated calls safe.
 */
export async function ensureAgendaSettingsExist(db: DatabaseExecutor, tenantId: string): Promise<void> {
  await db.query(
    `insert into pulso_iris.agenda_settings (tenant_id, mode, external_reference_required)
     values ($1, 'hybrid_manual', true)
     on conflict (tenant_id) do nothing`,
    [tenantId]
  );
}
