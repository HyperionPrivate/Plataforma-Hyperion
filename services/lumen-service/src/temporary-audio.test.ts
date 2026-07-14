import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { TemporaryAudioError, withTemporaryAudioFile, type TemporaryAudioCleanupState } from "./temporary-audio.js";

const cleanupDirectories: string[] = [];
const CLEANUP_OWNER = "lumen-test-1";

afterEach(async () => {
  await Promise.all(cleanupDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function newRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "lumen-temporary-audio-test-"));
  cleanupDirectories.push(parent);
  return { parent, root: join(parent, "private-audio") };
}

describe("private temporary audio", () => {
  it("uses private permissions, reads exact bytes and cleans the request directory after success", async () => {
    const { root } = await newRoot();
    const audio = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02]);
    let stagedPath = "";
    const cleanupState: TemporaryAudioCleanupState = { deleted: null };

    const result = await withTemporaryAudioFile(
      audio,
      { rootDirectory: root, extension: "webm", cleanupOwner: CLEANUP_OWNER, cleanupKey: randomUUID(), cleanupState },
      async (file) => {
        stagedPath = file.path;
        expect(file.fileName).toBe("audio.webm");
        expect(await file.read()).toEqual(audio);

        if (process.platform !== "win32") {
          expect((await stat(root)).mode & 0o777).toBe(0o700);
          expect((await stat(dirname(file.path))).mode & 0o777).toBe(0o700);
          expect((await stat(file.path)).mode & 0o777).toBe(0o600);
        }
        return "transcribed";
      }
    );

    expect(result).toBe("transcribed");
    expect(cleanupState.deleted).toBe(true);
    await expect(stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(root)).toEqual([]);
  });

  it("cleans the staged audio when the operation fails", async () => {
    const { root } = await newRoot();
    const providerFailure = new Error("provider failed");
    const cleanupState: TemporaryAudioCleanupState = { deleted: null };

    await expect(
      withTemporaryAudioFile(
        Buffer.from("audio"),
        { rootDirectory: root, extension: "ogg", cleanupOwner: CLEANUP_OWNER, cleanupKey: randomUUID(), cleanupState },
        async () => {
          throw providerFailure;
        }
      )
    ).rejects.toBe(providerFailure);

    expect(cleanupState.deleted).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects path-like extensions before creating temporary state", async () => {
    const { root } = await newRoot();

    await expect(
      withTemporaryAudioFile(
        Buffer.from("audio"),
        { rootDirectory: root, extension: "../wav", cleanupOwner: CLEANUP_OWNER, cleanupKey: randomUUID() },
        async () => undefined
      )
    ).rejects.toMatchObject({ name: "TemporaryAudioError", operation: "create" });
    await expect(stat(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("categorizes failure to create the private root without exposing audio", async () => {
    const { parent } = await newRoot();
    const occupiedPath = join(parent, "occupied");
    await writeFile(occupiedPath, "not-a-directory");
    const cleanupState: TemporaryAudioCleanupState = { deleted: null };

    const error = await withTemporaryAudioFile(
      Buffer.from("sensitive audio bytes"),
      {
        rootDirectory: occupiedPath,
        extension: "wav",
        cleanupOwner: CLEANUP_OWNER,
        cleanupKey: randomUUID(),
        cleanupState
      },
      async () => undefined
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TemporaryAudioError);
    expect(error).toMatchObject({ name: "TemporaryAudioError", operation: "create" });
    expect(String(error)).not.toContain("sensitive audio bytes");
    expect(cleanupState.deleted).toBe(true);
  });

  it("keeps the deterministic attempt directory pending when deletion fails", async () => {
    const { root } = await newRoot();
    const attemptId = randomUUID();
    const cleanupState: TemporaryAudioCleanupState = { deleted: null };
    let stagedDirectory = "";

    const error = await withTemporaryAudioFile(
      Buffer.from("audio"),
      {
        rootDirectory: root,
        extension: "wav",
        cleanupOwner: CLEANUP_OWNER,
        cleanupKey: attemptId,
        cleanupState,
        removeDirectory: async (path) => {
          stagedDirectory = path;
          throw new Error("simulated deletion failure");
        }
      },
      async () => "provider-result"
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ name: "TemporaryAudioError", operation: "cleanup" });
    expect(cleanupState.deleted).toBe(false);
    expect(stagedDirectory).toContain(`attempt-${attemptId}`);
    expect((await stat(stagedDirectory)).isDirectory()).toBe(true);
  });
});
