-- Complete the role-isolation invariant without rewriting the published 024
-- checksum. A service identity may neither inherit another role nor be granted
-- to another workload that could SET ROLE and impersonate it.

do $$
declare
  required_roles constant text[] := array[
    'hyperion_access',
    'hyperion_sofia',
    'hyperion_knowledge',
    'hyperion_audit',
    'hyperion_integration',
    'hyperion_pulso',
    'hyperion_channel',
    'hyperion_lumen'
  ];
begin
  if exists (
    select 1
      from pg_auth_members membership
      join pg_roles member_role on member_role.oid = membership.member
      join pg_roles granted_role on granted_role.oid = membership.roleid
     where member_role.rolname = any(required_roles)
        or granted_role.rolname = any(required_roles)
  ) then
    raise exception 'Hyperion service roles must not participate in role memberships in either direction';
  end if;
end
$$;
