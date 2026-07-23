-- JWT access-token denylist (jti). Rows expire with the token TTL so logout
-- closes the post-cookie window without unbounded growth.

create table platform.access_token_denylist (
  jti uuid primary key,
  expires_at timestamptz not null,
  revoked_at timestamptz not null default now(),
  constraint access_token_denylist_expires_after_revoke
    check (expires_at >= revoked_at)
);

create index if not exists ix_access_token_denylist_expires_at
  on platform.access_token_denylist (expires_at);

comment on table platform.access_token_denylist is
  'Access-owned JWT jti revocations. Identity inserts on logout; verify rejects until expires_at.';

revoke all privileges on table platform.access_token_denylist
  from public, hyperion_identity, hyperion_tenant;

grant select, insert, delete on table platform.access_token_denylist to hyperion_identity;
