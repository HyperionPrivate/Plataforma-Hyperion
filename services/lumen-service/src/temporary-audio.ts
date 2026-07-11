import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface TemporaryAudioFile {
  readonly path: string;
  readonly fileName: string;
  read(): Promise<Buffer>;
}

export interface TemporaryAudioOptions {
  rootDirectory: string;
  extension: string;
  cleanupState?: TemporaryAudioCleanupState;
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
 * Stages audio in an isolated, private directory for the duration of one
 * operation. The request directory and its contents are removed in `finally`
 * on success, provider failure, timeout and cancellation.
 */
export async function withTemporaryAudioFile<T>(
  audio: Buffer,
  options: TemporaryAudioOptions,
  operation: (file: TemporaryAudioFile) => Promise<T>
): Promise<T> {
  // Until a request directory exists, there is no temporary audio to remove.
  if (options.cleanupState) options.cleanupState.deleted = true;
  const extension = validateExtension(options.extension);
  let requestDirectory: string | undefined;
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };

  try {
    try {
      await mkdir(options.rootDirectory, { recursive: true, mode: 0o700 });
      await chmod(options.rootDirectory, 0o700);
      requestDirectory = await mkdtemp(join(options.rootDirectory, "request-"));
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
      await rm(requestDirectory, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
      if (options.cleanupState) options.cleanupState.deleted = true;
    } catch (error) {
      throw new TemporaryAudioError("cleanup", error);
    }
  }

  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

function validateExtension(value: string): string {
  const extension = value.trim().toLowerCase();
  if (!/^[a-z0-9]{1,8}$/.test(extension)) {
    throw new TemporaryAudioError("create");
  }
  return extension;
}
