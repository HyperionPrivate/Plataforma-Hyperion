import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TemporaryAudioFile {
  readonly path: string;
  readonly fileName: string;
  read(): Promise<Buffer>;
}

export interface TemporaryAudioOptions {
  rootDirectory: string;
  extension: string;
  cleanupOwner: string;
  cleanupKey: string;
  cleanupState?: TemporaryAudioCleanupState;
  removeDirectory?: (path: string) => Promise<void>;
}

export interface TemporaryAudioCleanupState {
  /** null before staging, false while cleanup is pending/failed, true only after successful deletion. */
  deleted: boolean | null;
}

export class TemporaryAudioError extends Error {
  readonly operation: "create" | "write" | "read" | "cleanup";

  constructor(operation: TemporaryAudioError["operation"], cause?: unknown) {
    super(`Temporary audio ${operation} failed`, cause === undefined ? undefined : { cause });
    this.name = "TemporaryAudioError";
    this.operation = operation;
  }
}

/**
 * Stages audio in an isolated, private, deterministic directory for one
 * processing attempt. Only the trusted owner and UUID are used to construct
 * the path; neither a database value nor an HTTP value can supply a path.
 */
export async function withTemporaryAudioFile<T>(
  audio: Buffer,
  options: TemporaryAudioOptions,
  operation: (file: TemporaryAudioFile) => Promise<T>
): Promise<T> {
  // Until a request directory exists, there is no temporary audio to remove.
  if (options.cleanupState) options.cleanupState.deleted = true;
  const extension = validateExtension(options.extension);
  const deterministicDirectory = temporaryAudioRequestDirectory(
    options.rootDirectory,
    options.cleanupOwner,
    options.cleanupKey
  );
  let requestDirectory: string | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };

  try {
    try {
      await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
      await chmod(options.rootDirectory, 0o700);
      await mkdir(deterministicDirectory.ownerDirectory, { recursive: true, mode: 0o700 });
      await chmod(deterministicDirectory.ownerDirectory, 0o700);
      requestDirectory = deterministicDirectory.requestDirectory;
      await mkdir(requestDirectory, { mode: 0o700 });
      if (options.cleanupState) options.cleanupState.deleted = false;
      await chmod(requestDirectory, 0o700);
    } catch (error) {
      throw new TemporaryAudioError("create", error);
    }

    const fileName = `audio.${extension}`;
    const path = join(requestDirectory, fileName);
    try {
      await writeFile(path, audio, { flag: "wx", mode: 0o600 });
      await chmod(path, 0o600);
    } catch (error) {
      throw new TemporaryAudioError("write", error);
    }

    const value = await operation({
      path,
      fileName,
      async read(): Promise<Buffer> {
        try {
          return await readFile(path);
        } catch (error) {
          throw new TemporaryAudioError("read", error);
        }
      }
    });
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }

  if (requestDirectory) {
    if (options.cleanupState) options.cleanupState.deleted = false;
    try {
      await (options.removeDirectory ?? removeTemporaryAudioDirectory)(requestDirectory);
      // Remove only the now-empty owner directory. ENOTEMPTY means another
      // active attempt exists and is intentionally left untouched.
      await rmdir(deterministicDirectory.ownerDirectory).catch(() => undefined);
      if (options.cleanupState) options.cleanupState.deleted = true;
    } catch (error) {
      throw new TemporaryAudioError("cleanup", error);
    }
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

export function temporaryAudioRequestDirectory(
  rootDirectory: string,
  cleanupOwner: string,
  cleanupKey: string
): { ownerDirectory: string; requestDirectory: string } {
  const owner = validateCleanupOwner(cleanupOwner);
  const attemptId = validateCleanupKey(cleanupKey);
  const ownerKey = createHash("sha256").update(owner, "utf8").digest("hex").slice(0, 32);
  const ownerDirectory = join(rootDirectory, `owner-${ownerKey}`);
  return {
    ownerDirectory,
    requestDirectory: join(ownerDirectory, `attempt-${attemptId}`)
  };
}

export async function removeTemporaryAudioDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
}

function validateExtension(value: string): string {
  const extension = value.trim().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension)) {
    throw new TemporaryAudioError("create");
  }
  return extension;
}

function validateCleanupOwner(value: string): string {
  const owner = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(owner)) {
    throw new TemporaryAudioError("create");
  }
  return owner;
}

function validateCleanupKey(value: string): string {
  const attemptId = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attemptId)) {
    throw new TemporaryAudioError("create");
  }
  return attemptId;
}
