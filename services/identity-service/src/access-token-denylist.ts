import type { DatabaseExecutor } from "@hyperion/database";

export async function isAccessTokenJtiRevoked(db: DatabaseExecutor, jti: string): Promise<boolean> {
  const result = await db.query<{ jti: string }>(
    `select jti
     from platform.access_token_denylist
     where jti = $1::uuid
       and expires_at > now()
     limit 1`,
    [jti]
  );
  return result.rows.length > 0;
}

export async function revokeAccessTokenJti(db: DatabaseExecutor, jti: string, expiresAt: Date | string): Promise<void> {
  await db.query(
    `insert into platform.access_token_denylist (jti, expires_at)
     values ($1::uuid, $2::timestamptz)
     on conflict (jti) do nothing`,
    [jti, expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt]
  );
}
