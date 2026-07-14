-- Negative fixture: PL/pgSQL body with cross-owner SQL + SECURITY DEFINER.
-- architecture:test expects detectBoundaryViolations to flag this sample.
-- Do not apply this file to any database.

create or replace function alpha.leaky_reader()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  perform 1 from beta.foreign_records where id = new.id;
  return new;
end;
$$;

create trigger trg_alpha_leaky
before insert on alpha.own_items
for each row execute function alpha.leaky_reader();
