-- hyperion:no-transaction
-- Early safety fence for both fresh installs and databases that exercised an
-- earlier PR #18 draft. It sorts before every autonomy migration, so no new
-- DDL runs while a service identity can still connect.

-- Commit NOLOGIN first. Existing sessions survive ALTER ROLE; committing this
-- block prevents new sessions from racing the subsequent drain check.
-- hyperion:statement
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
  role_name text;
begin
  foreach role_name in array required_roles loop
    if exists (select 1 from pg_roles where rolname = role_name) then
      execute format('alter role %I nologin', role_name);
    end if;
  end loop;
end
$$;

-- This block may fail after the fence committed. That is intentional: all
-- identities remain NOLOGIN while operators drain old sessions, then the
-- migration can be replayed safely.
-- hyperion:statement
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
      from pg_roles
     where rolname = any(required_roles)
       and rolcanlogin
  ) then
    raise exception 'Hyperion service roles must remain NOLOGIN until the validated bootstrap';
  end if;

  if exists (
    select 1
      from pg_stat_activity activity
     where activity.usename = any(required_roles)
       and activity.pid <> pg_backend_pid()
       and activity.backend_type = 'client backend'
  ) then
    raise exception using
      errcode = '55006',
      message = 'drain all Hyperion service database sessions before applying role migrations';
  end if;
end
$$;
