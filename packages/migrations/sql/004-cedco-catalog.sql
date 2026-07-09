-- Tenant operativo CEDCO y catalogo real de configuracion de PULSO IRIS.
-- Datos publicos de base_comun.md: sedes, convenios y tipos de cita.
-- Los profesionales NO se siembran aqui (no hay nombres reales publicos):
-- se crean desde Configuracion o con el seed demo sintetico.

insert into platform.tenants (slug, display_name, status, metadata)
values (
  'cedco',
  'CEDCO',
  'active',
  '{"legalName":"Centro de Diagnostico y Cirugia Ocular CEDCO S.A.S.","nit":"804013775-2","city":"Bucaramanga","product":"PULSO_IRIS"}'::jsonb
)
on conflict (slug) do nothing;

-- Todos los operadores admin quedan asignados al tenant CEDCO.
insert into platform.operator_tenants (operator_id, tenant_id)
select o.id, t.id
from platform.operators o
cross join platform.tenants t
where t.slug = 'cedco'
on conflict do nothing;

-- Columnas de catalogo que faltaban frente al modelo del requerimiento.
alter table pulso_iris.sites
  add column if not exists address text,
  add column if not exists phone text;

alter table pulso_iris.professionals
  add column if not exists subspecialty text;

alter table pulso_iris.administrative_patients
  add column if not exists phone text;

create table if not exists pulso_iris.appointment_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references platform.tenants(id) on delete cascade,
  name text not null,
  category text not null check (category in ('consulta', 'ayuda_dx', 'valoracion_qx', 'control_post')),
  duration_min integer not null default 20,
  preparation_text text,
  bookable_by_ia boolean not null default true,
  slot_priority integer not null default 50,
  status text not null default 'active' check (status in ('active', 'paused')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name)
);

create index if not exists idx_pulso_iris_appointment_types_tenant on pulso_iris.appointment_types(tenant_id);

-- Sedes reales de CEDCO (4).
insert into pulso_iris.sites (tenant_id, name, city, address, phone, status, metadata)
select t.id, s.name, s.city, s.address, s.phone, 'active', s.metadata::jsonb
from platform.tenants t
cross join (
  values
    ('Sede Principal Sotomayor', 'Bucaramanga', 'Calle 48 No. 27-49, Sotomayor', '316 454 4010', '{"kind":"principal"}'),
    ('Sede CES', 'Bucaramanga', 'Calle 50 # 28-25 piso 7, Centro Empresarial Sotomayor', '316 454 4010', '{"kind":"ces"}'),
    ('Sede CIE Piedecuesta', 'Piedecuesta', 'Torre Sur piso 3, Consultorio 312', '315 970 0333', '{"kind":"cie"}'),
    ('Sede Barrancabermeja', 'Barrancabermeja', 'Calle 57 No. 27-15, Edificio Cajasan', '315 970 0333', '{"kind":"barranca"}')
) as s(name, city, address, phone, metadata)
where t.slug = 'cedco'
  and not exists (
    select 1 from pulso_iris.sites x where x.tenant_id = t.id and x.name = s.name
  );

-- Convenios reales (grupos segun el marco transversal del requerimiento).
insert into pulso_iris.payers (tenant_id, name, payer_group, requires_authorization, status, metadata)
select t.id, p.name, p.payer_group, p.requires_authorization, 'active', p.metadata::jsonb
from platform.tenants t
cross join (
  values
    ('EPS Sanitas', 'eps', true, '{"line":"316 454 4010"}'),
    ('PONAL', 'eps', true, '{"line":"316 454 4010"}'),
    ('HOSMIR', 'eps', true, '{"line":"316 454 4010"}'),
    ('SURA PAC', 'eps', true, '{"line":"316 454 4010"}'),
    ('Salud Mia', 'eps', true, '{"line":"316 454 4010"}'),
    ('Medicina Prepagada', 'private_prepaid', false, '{"line":"315 970 0333"}'),
    ('Polizas', 'policy', false, '{"line":"315 970 0333"}'),
    ('Ecopetrol', 'policy', false, '{"line":"315 970 0333"}'),
    ('FOMAG', 'policy', false, '{"line":"315 970 0333"}'),
    ('Particular', 'particular', false, '{"line":"315 970 0333"}')
) as p(name, payer_group, requires_authorization, metadata)
where t.slug = 'cedco'
  and not exists (
    select 1 from pulso_iris.payers x where x.tenant_id = t.id and x.name = p.name
  );

-- Catalogo base de tipos de cita (reglas del marco transversal, se valida en Fase 0).
insert into pulso_iris.appointment_types (tenant_id, name, category, duration_min, preparation_text, bookable_by_ia, slot_priority)
select t.id, a.name, a.category, a.duration_min, a.preparation_text, a.bookable_by_ia, a.slot_priority
from platform.tenants t
cross join (
  values
    ('Consulta oftalmologia primera vez', 'consulta', 20, null, true, 50),
    ('Consulta oftalmologia control', 'consulta', 15, null, true, 50),
    ('Consulta optometria', 'consulta', 20, null, true, 50),
    ('OCT macular', 'ayuda_dx', 15, 'Le dilataran la pupila: no conduzca y asista con acompanante. Traiga documento, orden medica y carne.', true, 45),
    ('Campimetria', 'ayuda_dx', 20, 'Traiga sus gafas de formula vigente, documento y orden medica.', true, 45),
    ('Ecografia ocular', 'ayuda_dx', 15, 'No requiere preparacion especial. Traiga documento y orden medica.', true, 45),
    ('Angiografia retiniana', 'ayuda_dx', 30, 'Requiere ayuno de 4 horas y acompanante. Le dilataran la pupila: no conduzca.', true, 40),
    ('Topografia corneal', 'ayuda_dx', 15, 'Suspenda lentes de contacto blandos 3 dias antes (rigidos: 2 semanas).', true, 45),
    ('Paquimetria', 'ayuda_dx', 10, 'No requiere preparacion especial. Traiga documento y orden medica.', true, 45),
    ('Valoracion prequirurgica', 'valoracion_qx', 30, 'Traiga examenes previos, orden medica y listado de medicamentos que toma. La programacion de cirugia la coordina un asesor.', true, 30),
    ('Control postoperatorio dia 1', 'control_post', 15, 'Asista con acompanante. Ante dolor intenso, secrecion o baja de vision, acuda de inmediato a urgencias.', true, 10),
    ('Control postoperatorio semana 1', 'control_post', 15, null, true, 15),
    ('Control postoperatorio mes 1', 'control_post', 15, null, true, 20)
) as a(name, category, duration_min, preparation_text, bookable_by_ia, slot_priority)
where t.slug = 'cedco'
  and not exists (
    select 1 from pulso_iris.appointment_types x where x.tenant_id = t.id and x.name = a.name
  );
