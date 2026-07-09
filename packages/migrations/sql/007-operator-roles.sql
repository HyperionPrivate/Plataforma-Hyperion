-- Roles canonicos de operacion PULSO IRIS.
-- admin: administracion total.
-- coordinator: coordina operacion y configuracion.
-- advisor: opera casos/citas/conversaciones.
-- auditor: lectura solamente.

update platform.operators
set role = 'coordinator'
where role = 'operator';

update platform.operators
set role = 'admin'
where role is null or trim(role) = '';

alter table platform.operators
  drop constraint if exists chk_platform_operators_role;

alter table platform.operators
  add constraint chk_platform_operators_role
    check (role in ('admin', 'coordinator', 'advisor', 'auditor'));
