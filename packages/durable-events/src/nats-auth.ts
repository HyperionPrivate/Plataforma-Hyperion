const NATS_USERNAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_NATS_SECRET_LENGTH = 2_048;
const NATS_SERVER_CONFIGURATION_SECRET_PATTERN = /^[A-Za-z][A-Za-z0-9._~-]*$/;

export type NatsAuthentication =
  | Readonly<{
      authToken: string;
      username?: never;
      password?: never;
    }>
  | Readonly<{
      authToken?: never;
      username: string;
      password: string;
    }>;

/** Per-identity reply namespace used by request/reply and JetStream API calls. */
export function natsInboxPrefix(authentication: NatsAuthentication | undefined): string {
  return `_INBOX.${authentication?.username ?? "local"}`;
}

export interface NatsAuthenticationInput {
  readonly authToken?: string;
  readonly username?: string;
  readonly password?: string;
}

export interface ReadNatsAuthenticationOptions {
  readonly required?: boolean;
  readonly minimumSecretLength?: number;
  readonly serverConfigurationSafe?: boolean;
  /** Disable legacy token credentials when a distinct service identity is required. */
  readonly allowToken?: boolean;
}

/**
 * Validates credentials without ever interpolating their values into an error.
 * Token and username/password are intentionally mutually exclusive.
 */
export function readNatsAuthentication(
  input: NatsAuthenticationInput,
  options: ReadNatsAuthenticationOptions = {}
): NatsAuthentication | undefined {
  if (!input || typeof input !== "object") {
    throw new TypeError("NATS authentication input is required");
  }

  const minimumSecretLength = options.minimumSecretLength ?? 1;
  if (!Number.isSafeInteger(minimumSecretLength) || minimumSecretLength < 1 || minimumSecretLength > 256) {
    throw new TypeError("minimumSecretLength must be an integer between 1 and 256");
  }
  const authToken = optionalSecret(
    input.authToken,
    "NATS_AUTH_TOKEN",
    minimumSecretLength,
    options.serverConfigurationSafe === true
  );
  const username = optionalUsername(input.username);
  const password = optionalSecret(
    input.password,
    "NATS_PASSWORD",
    minimumSecretLength,
    options.serverConfigurationSafe === true
  );

  if (authToken !== undefined && (username !== undefined || password !== undefined)) {
    throw new Error("NATS token and username/password authentication are mutually exclusive");
  }
  if (authToken !== undefined && options.allowToken === false) {
    throw new Error("NATS token authentication is not allowed in this environment");
  }
  if ((username === undefined) !== (password === undefined)) {
    throw new Error("NATS_USERNAME and NATS_PASSWORD must be provided together");
  }
  if (authToken !== undefined) {
    return { authToken };
  }
  if (username !== undefined && password !== undefined) {
    return { username, password };
  }
  if (options.required === true) {
    throw new Error("NATS authentication is required");
  }
  return undefined;
}

function optionalUsername(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError("NATS_USERNAME must be a safe username");
  }
  const normalized = value.trim();
  if (!NATS_USERNAME_PATTERN.test(normalized)) {
    throw new TypeError("NATS_USERNAME must be a safe username");
  }
  return normalized;
}

function optionalSecret(
  value: string | undefined,
  name: "NATS_AUTH_TOKEN" | "NATS_PASSWORD",
  minimumLength: number,
  serverConfigurationSafe: boolean
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length < minimumLength ||
    value.length > MAX_NATS_SECRET_LENGTH ||
    hasControlCharacter(value) ||
    (serverConfigurationSafe && !NATS_SERVER_CONFIGURATION_SECRET_PATTERN.test(value))
  ) {
    throw new TypeError(`${name} must meet the configured length and character requirements`);
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}
