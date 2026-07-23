export const PLATFORM_POSTGRES_RECOVERY_MANIFEST = Object.freeze({
  access: Object.freeze({
    displayName: "Access",
    profile: "access",
    composeProfile: "access-ops",
    sourceDatabase: "hyperion_access",
    restoreDatabase: "hyperion_access_restore_drill",
    migratorRole: "hyperion_access_migrator",
    runtimeRoles: Object.freeze(["hyperion_identity", "hyperion_tenant"]),
    runtimeTablePrivileges: Object.freeze({
      hyperion_identity: Object.freeze({
        "access_runtime.bootstrap_tenants": Object.freeze(["SELECT"]),
        "access_runtime.lumen_projection_outbox": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
        "access_runtime.lumen_projection_state": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
        "access_runtime.migration_ledger": Object.freeze(["SELECT"]),
        "access_runtime.product_grants": Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]),
        "access_runtime.tenant_projection_outbox": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
        "access_runtime.tenant_projection_state": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
        "platform.operator_sessions": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
        "platform.operator_tenants": Object.freeze(["SELECT", "INSERT", "DELETE"]),
        "platform.operators": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
        "platform.tenants": Object.freeze(["SELECT"])
      }),
      hyperion_tenant: Object.freeze({
        "access_runtime.bootstrap_tenants": Object.freeze([]),
        "access_runtime.lumen_projection_outbox": Object.freeze([]),
        "access_runtime.lumen_projection_state": Object.freeze([]),
        "access_runtime.migration_ledger": Object.freeze(["SELECT"]),
        "access_runtime.product_grants": Object.freeze([]),
        "access_runtime.tenant_projection_outbox": Object.freeze([]),
        "access_runtime.tenant_projection_state": Object.freeze([]),
        "platform.operator_sessions": Object.freeze([]),
        "platform.operator_tenants": Object.freeze([]),
        "platform.operators": Object.freeze([]),
        "platform.tenants": Object.freeze(["SELECT"])
      })
    }),
    runtimeRoutinePrivileges: Object.freeze({
      "access_runtime.enforce_tenant_lifecycle_v1()": Object.freeze([]),
      "access_runtime.valid_grant_values(text[],text)": Object.freeze(["hyperion_identity"])
    }),
    schemas: Object.freeze(["access_runtime", "platform"]),
    triggers: Object.freeze({
      "platform.tenants.trg_access_tenant_lifecycle_v1": "A"
    }),
    tables: Object.freeze([
      "access_runtime.bootstrap_tenants",
      "access_runtime.lumen_projection_outbox",
      "access_runtime.lumen_projection_state",
      "access_runtime.migration_ledger",
      "access_runtime.product_grants",
      "access_runtime.tenant_projection_outbox",
      "access_runtime.tenant_projection_state",
      "platform.operator_sessions",
      "platform.operator_tenants",
      "platform.operators",
      "platform.tenants"
    ]),
    ledgerTable: "access_runtime.migration_ledger",
    migrationPackage: "@hyperion/access-migrations",
    migrationDirectory: "packages/access-migrations/sql",
    migrationLedger: Object.freeze([
      Object.freeze({
        name: "001-access-fresh-baseline.sql",
        checksum: "e24c32b0055a84f319328ed524a25f6ccd348db0bbd1dbd864dbb29bd7b42328"
      }),
      Object.freeze({
        name: "002-access-runtime-role-boundary.sql",
        checksum: "3abcdfac4af18a3cbb4066741198d601a6e1b4a57c014c41dba7f5fc849ce24d"
      }),
      Object.freeze({
        name: "003-access-tenant-projection.sql",
        checksum: "5fb558a7d36899e98e532b22e0134665187f3c4db75f63a155cfe9d31821e7c8"
      }),
      Object.freeze({
        name: "004-access-tenant-lifecycle-integrity.sql",
        checksum: "c17283b147bcc57cd66e040e4b8f91e20285667f4c2dd1d23c16671b55d61a08"
      }),
      Object.freeze({
        name: "005-access-jwt-denylist.sql",
        checksum: "3c88553e9d4d5a6085b8e80c5ef2a7d4391e02fac30ee1ff0c26b0f33e92c7a7"
      })
    ]),
    markerInsertSql: `insert into platform.tenants (id, slug, display_name, status, metadata)
      values ('00000000-0000-4000-8000-00000000f001', 'access-recovery-drill',
              'Access Recovery Drill', 'paused', '{"recoveryDrill":true}'::jsonb)`,
    markerCountSql: "select count(*)::int from platform.tenants where id = '00000000-0000-4000-8000-00000000f001'::uuid"
  }),
  audit: Object.freeze({
    displayName: "Audit",
    profile: "audit",
    composeProfile: "audit-ops",
    sourceDatabase: "hyperion_audit",
    restoreDatabase: "hyperion_audit_restore_drill",
    migratorRole: "hyperion_audit_migrator",
    runtimeRoles: Object.freeze(["hyperion_audit"]),
    runtimeTablePrivileges: Object.freeze({
      hyperion_audit: Object.freeze({
        "audit_runtime.inbox_events": Object.freeze(["SELECT", "INSERT"]),
        "audit_runtime.migration_ledger": Object.freeze(["SELECT"]),
        "platform.audit_events": Object.freeze(["SELECT", "INSERT"])
      })
    }),
    runtimeRoutinePrivileges: Object.freeze({}),
    schemas: Object.freeze(["audit_runtime", "platform"]),
    triggers: Object.freeze({}),
    tables: Object.freeze(["audit_runtime.inbox_events", "audit_runtime.migration_ledger", "platform.audit_events"]),
    ledgerTable: "audit_runtime.migration_ledger",
    migrationPackage: "@hyperion/audit-migrations",
    migrationDirectory: "packages/audit-migrations/sql",
    migrationLedger: Object.freeze([
      Object.freeze({
        name: "001-audit-autonomous-baseline.sql",
        checksum: "30ec6157679c70641ea6ce9c030a84e0938258167888a04eb4af18798db0a571"
      })
    ]),
    markerInsertSql: `insert into platform.audit_events
      (id, tenant_id, actor_id, event_type, entity_type, entity_id, metadata, source_event_id)
      values ('00000000-0000-4000-8000-00000000f002', null, 'recovery-drill',
              'platform.recovery.drill.v1', 'recovery', 'audit', '{"recoveryDrill":true}'::jsonb,
              '00000000-0000-4000-8000-00000000f002')`,
    markerCountSql:
      "select count(*)::int from platform.audit_events where id = '00000000-0000-4000-8000-00000000f002'::uuid"
  })
});

export function getPlatformRecoveryProvider(provider) {
  const value = PLATFORM_POSTGRES_RECOVERY_MANIFEST[provider];
  if (!value) throw new Error(`Unknown platform recovery provider: ${provider}`);
  return value;
}
