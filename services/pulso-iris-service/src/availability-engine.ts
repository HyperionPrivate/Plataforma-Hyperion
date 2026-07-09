import {
  pulsoIrisAvailabilitySlotsSchema,
  type PulsoIrisAvailabilitySlot,
  type PulsoIrisAvailabilitySlots,
  type PulsoIrisSlotAlternative
} from "@hyperion/contracts";
import type { ServiceContext } from "@hyperion/service-runtime";

type Database = Pick<NonNullable<ServiceContext["db"]>, "query">;

export interface AvailabilitySlotFilters {
  tenantId: string;
  from: Date;
  to: Date;
  siteId?: string;
  professionalId?: string;
  appointmentTypeId?: string;
  payerId?: string;
  includeFull?: boolean;
  excludeAppointmentId?: string;
  limit?: number;
}

export interface SlotReservationRequest {
  tenantId: string;
  siteId: string;
  professionalId: string;
  appointmentTypeId: string;
  scheduledAt: string;
  payerId?: string;
  excludeAppointmentId?: string;
}

export interface SlotReservationResult {
  slot: PulsoIrisAvailabilitySlot;
  slotCapacityToken: number;
}

const SLOT_SQL = `
with params as (
  select
    $1::uuid as tenant_id,
    $2::timestamptz as from_ts,
    $3::timestamptz as to_ts,
    $4::uuid as site_id,
    $5::uuid as professional_id,
    $6::uuid as appointment_type_id,
    $7::boolean as include_full,
    $8::uuid as exclude_appointment_id,
    $9::int as row_limit,
    $10::uuid as payer_id,
    coalesce(
      (select s.timezone from pulso_iris.agenda_settings s where s.tenant_id = $1::uuid),
      'America/Bogota'
    ) as tenant_timezone
),
local_days as (
  select generate_series(
    timezone(tenant_timezone, from_ts)::date,
    timezone(tenant_timezone, to_ts)::date,
    interval '1 day'
  )::date as local_date
  from params
),
rule_windows as (
  select
    r.id,
    r.tenant_id,
    r.site_id,
    r.professional_id,
    r.appointment_type_id,
    r.slot_duration_min,
    r.capacity,
    (d.local_date::timestamp + r.starts_at) at time zone r.timezone as window_start,
    (d.local_date::timestamp + r.ends_at) at time zone r.timezone as window_end
  from params p
  join pulso_iris.availability_rules r
    on r.tenant_id = p.tenant_id
   and r.status = 'active'
   and (p.site_id is null or r.site_id = p.site_id)
   and (p.professional_id is null or r.professional_id = p.professional_id)
   and (p.appointment_type_id is null or r.appointment_type_id = p.appointment_type_id)
  join pulso_iris.agenda_settings settings
    on settings.tenant_id = r.tenant_id
   and settings.status = 'active'
  join pulso_iris.sites site
    on site.tenant_id = r.tenant_id
   and site.id = r.site_id
   and site.status = 'active'
  join pulso_iris.professionals professional
    on professional.tenant_id = r.tenant_id
   and professional.id = r.professional_id
   and professional.status = 'active'
  join pulso_iris.appointment_types appointment_type
    on appointment_type.tenant_id = r.tenant_id
   and appointment_type.id = r.appointment_type_id
   and appointment_type.status = 'active'
   and appointment_type.bookable_by_ia is true
  join local_days d
    on extract(dow from d.local_date)::int = r.weekday
   and (r.effective_from is null or r.effective_from <= d.local_date)
   and (r.effective_to is null or r.effective_to >= d.local_date)
   and not exists (
     select 1
     from pulso_iris.holidays h
     where h.tenant_id = p.tenant_id
       and h.status = 'active'
       and h.holiday_date = d.local_date
   )
    and (
     p.payer_id is null
     or not exists (
       select 1
       from pulso_iris.professional_payer_exclusions e
       where e.tenant_id = p.tenant_id
         and e.status = 'active'
         and e.professional_id = r.professional_id
         and e.payer_id = p.payer_id
      )
    )
    and exists (
      select 1
      from pulso_iris.professional_sites ps
      where ps.tenant_id = r.tenant_id
        and ps.professional_id = r.professional_id
        and ps.site_id = r.site_id
        and ps.status = 'active'
    )
    and exists (
      select 1
      from pulso_iris.professional_appointment_types pat
      where pat.tenant_id = r.tenant_id
        and pat.professional_id = r.professional_id
        and pat.appointment_type_id = r.appointment_type_id
        and pat.status = 'active'
    )
),
candidate_slots as (
  select
    rw.id as rule_id,
    rw.tenant_id,
    rw.site_id,
    rw.professional_id,
    rw.appointment_type_id,
    gs.starts_at,
    gs.starts_at + (rw.slot_duration_min * interval '1 minute') as ends_at,
    rw.capacity
  from rule_windows rw
  cross join lateral generate_series(
    rw.window_start,
    rw.window_end - (rw.slot_duration_min * interval '1 minute'),
    rw.slot_duration_min * interval '1 minute'
  ) as gs(starts_at)
),
booked_slots as (
  select
    s.rule_id,
    s.tenant_id,
    s.site_id,
    s.professional_id,
    s.appointment_type_id,
    s.starts_at,
    s.ends_at,
    s.capacity,
    (
      count(a.id)::int +
      (
        select count(*)::int
        from pulso_iris.appointment_holds h
        where h.tenant_id = s.tenant_id
          and h.site_id = s.site_id
          and h.professional_id = s.professional_id
          and h.appointment_type_id = s.appointment_type_id
          and h.scheduled_at = s.starts_at
          and h.status = 'active'
          and h.expires_at > now()
      )
    )::int as booked
  from params p
  join candidate_slots s on true
  left join pulso_iris.appointments a
    on a.tenant_id = s.tenant_id
   and a.site_id = s.site_id
   and a.professional_id = s.professional_id
   and a.appointment_type_id = s.appointment_type_id
   and a.scheduled_at = s.starts_at
   and a.status not in ('cancelled', 'no_show', 'rescheduled', 'external_rejected', 'expired', 'failed')
   and (p.exclude_appointment_id is null or a.id <> p.exclude_appointment_id)
  where s.starts_at >= p.from_ts
    and s.starts_at < p.to_ts
    and not exists (
      select 1
      from pulso_iris.agenda_blocks b
      where b.tenant_id = s.tenant_id
        and b.status = 'active'
        and b.starts_at < s.ends_at
        and b.ends_at > s.starts_at
        and (b.site_id is null or b.site_id = s.site_id)
        and (b.professional_id is null or b.professional_id = s.professional_id)
        and (b.appointment_type_id is null or b.appointment_type_id = s.appointment_type_id)
    )
  group by
    s.rule_id,
    s.tenant_id,
    s.site_id,
    s.professional_id,
    s.appointment_type_id,
    s.starts_at,
    s.ends_at,
    s.capacity
)
select
  b.rule_id as "ruleId",
  b.site_id as "siteId",
  b.professional_id as "professionalId",
  b.appointment_type_id as "appointmentTypeId",
  b.starts_at as "startsAt",
  b.ends_at as "endsAt",
  b.capacity,
  b.booked,
  greatest(b.capacity - b.booked, 0)::int as remaining,
  case when b.booked >= b.capacity then 'full' else 'available' end as status,
  s.name as "siteName",
  p.name as "professionalName",
  p.is_pilot as "professionalIsPilot",
  t.name as "appointmentTypeName",
  t.category as "appointmentCategory"
from params par
join booked_slots b on true
left join pulso_iris.sites s on s.tenant_id = b.tenant_id and s.id = b.site_id
left join pulso_iris.professionals p on p.tenant_id = b.tenant_id and p.id = b.professional_id
left join pulso_iris.appointment_types t on t.tenant_id = b.tenant_id and t.id = b.appointment_type_id
where par.include_full or b.booked < b.capacity
order by b.starts_at, t.slot_priority, p.name
limit (select row_limit from params)
`;

export async function listAvailabilitySlots(
  db: Database,
  filters: AvailabilitySlotFilters
): Promise<PulsoIrisAvailabilitySlots> {
  const result = await db.query(SLOT_SQL, [
    filters.tenantId,
    filters.from.toISOString(),
    filters.to.toISOString(),
    filters.siteId ?? null,
    filters.professionalId ?? null,
    filters.appointmentTypeId ?? null,
    filters.includeFull ?? false,
    filters.excludeAppointmentId ?? null,
    filters.limit ?? 500,
    filters.payerId ?? null
  ]);

  return pulsoIrisAvailabilitySlotsSchema.parse({
    from: filters.from,
    to: filters.to,
    slots: result.rows
  });
}

export async function reserveAppointmentSlotToken(
  db: Database,
  request: SlotReservationRequest
): Promise<SlotReservationResult | undefined> {
  const scheduledAt = new Date(request.scheduledAt);
  const lookupTo = new Date(scheduledAt.getTime() + 1000);
  const availability = await listAvailabilitySlots(db, {
    tenantId: request.tenantId,
    from: scheduledAt,
    to: lookupTo,
    siteId: request.siteId,
    professionalId: request.professionalId,
    appointmentTypeId: request.appointmentTypeId,
    payerId: request.payerId,
    includeFull: false,
    excludeAppointmentId: request.excludeAppointmentId,
    limit: 1
  });

  const slot = availability.slots[0];
  if (!slot || slot.remaining <= 0) {
    return undefined;
  }

  const token = await db.query<{ token: number }>(
    `select slots.token::int
     from generate_series(1, $6::int) as slots(token)
     where not exists (
       select 1
       from pulso_iris.appointments a
       where a.tenant_id = $1
         and a.site_id = $2
         and a.professional_id = $3
         and a.appointment_type_id = $4
         and a.scheduled_at = $5::timestamptz
         and a.slot_capacity_token = slots.token
          and a.status not in ('cancelled', 'no_show', 'rescheduled', 'external_rejected', 'expired', 'failed')
          and ($7::uuid is null or a.id <> $7::uuid)
      )
      and not exists (
        select 1
        from pulso_iris.appointment_holds h
        where h.tenant_id = $1
          and h.site_id = $2
          and h.professional_id = $3
          and h.appointment_type_id = $4
          and h.scheduled_at = $5::timestamptz
          and h.slot_capacity_token = slots.token
          and h.status = 'active'
          and h.expires_at > now()
      )
     order by slots.token
     limit 1`,
    [
      request.tenantId,
      request.siteId,
      request.professionalId,
      request.appointmentTypeId,
      scheduledAt.toISOString(),
      slot.capacity,
      request.excludeAppointmentId ?? null
    ]
  );

  const slotCapacityToken = token.rows[0]?.token;
  if (!slotCapacityToken) {
    return undefined;
  }

  return { slot, slotCapacityToken };
}

export async function listSlotAlternatives(
  db: Database,
  request: {
    tenantId: string;
    siteId: string;
    professionalId: string;
    appointmentTypeId: string;
    from: string;
    payerId?: string;
    excludeAppointmentId?: string;
    limit?: number;
    horizonEnd?: Date;
  }
): Promise<PulsoIrisSlotAlternative[]> {
  const from = new Date(request.from);
  const defaultTo = new Date(from.getTime() + 14 * 24 * 60 * 60 * 1000);
  const to = request.horizonEnd && request.horizonEnd < defaultTo ? request.horizonEnd : defaultTo;
  if (to <= from) return [];
  const availability = await listAvailabilitySlots(db, {
    tenantId: request.tenantId,
    from,
    to,
    siteId: request.siteId,
    professionalId: request.professionalId,
    appointmentTypeId: request.appointmentTypeId,
    payerId: request.payerId,
    includeFull: false,
    excludeAppointmentId: request.excludeAppointmentId,
    limit: request.limit ?? 3
  });

  return availability.slots
    .filter((slot) => new Date(slot.startsAt).getTime() !== from.getTime())
    .slice(0, request.limit ?? 3)
    .map((slot) => ({
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      siteId: slot.siteId,
      professionalId: slot.professionalId,
      appointmentTypeId: slot.appointmentTypeId,
      remaining: slot.remaining,
      siteName: slot.siteName,
      professionalName: slot.professionalName,
      appointmentTypeName: slot.appointmentTypeName
    }));
}

export async function isProfessionalExcludedForPayer(
  db: Database,
  tenantId: string,
  professionalId: string,
  payerId: string
): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `select exists(
       select 1
       from pulso_iris.professional_payer_exclusions
       where tenant_id = $1
         and professional_id = $2
         and payer_id = $3
         and status = 'active'
     ) as "exists"`,
    [tenantId, professionalId, payerId]
  );
  return Boolean(result.rows[0]?.exists);
}
