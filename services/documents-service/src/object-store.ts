import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { readDeploymentEnvironment } from "@hyperion/nova-config";

export interface StoredObject {
  storageKey: string;
  byteSize: number;
  checksumSha256: string;
}

export interface ObjectStore {
  put(input: { tenantId: string; documentId: string; contentType: string; bytes: Buffer }): Promise<StoredObject>;
  get(storageKey: string): Promise<Buffer>;
}

export class LocalMockObjectStore implements ObjectStore {
  constructor(private readonly rootDirectory: string) {}

  async put(input: {
    tenantId: string;
    documentId: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<StoredObject> {
    const storageKey = `${input.tenantId}/${input.documentId}`;
    const absolutePath = join(this.rootDirectory, storageKey);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, input.bytes);

    const checksumSha256 = createHash("sha256").update(input.bytes).digest("hex");
    return {
      storageKey,
      byteSize: input.bytes.byteLength,
      checksumSha256
    };
  }

  async get(storageKey: string): Promise<Buffer> {
    const absolutePath = join(this.rootDirectory, storageKey);
    return readFile(absolutePath);
  }
}

export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(options: {
    bucket: string;
    region: string;
    endpoint?: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle?: boolean;
  }) {
    this.bucket = options.bucket;
    this.client = new S3Client({
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle ?? Boolean(options.endpoint),
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey
      }
    });
  }

  async put(input: {
    tenantId: string;
    documentId: string;
    contentType: string;
    bytes: Buffer;
  }): Promise<StoredObject> {
    const storageKey = `${input.tenantId}/${input.documentId}`;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: storageKey,
        Body: input.bytes,
        ContentType: input.contentType
      })
    );

    const checksumSha256 = createHash("sha256").update(input.bytes).digest("hex");
    return {
      storageKey,
      byteSize: input.bytes.byteLength,
      checksumSha256
    };
  }

  async get(storageKey: string): Promise<Buffer> {
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: storageKey
      })
    );
    const body = response.Body;
    if (!body) throw new Error(`S3 object not found: ${storageKey}`);
    const bytes = await body.transformToByteArray();
    return Buffer.from(bytes);
  }
}

export function createObjectStore(env: NodeJS.ProcessEnv = process.env): ObjectStore {
  const bucket = env.DOCUMENTS_S3_BUCKET?.trim();
  if (bucket) {
    const accessKeyId = env.DOCUMENTS_S3_ACCESS_KEY?.trim();
    const secretAccessKey = env.DOCUMENTS_S3_SECRET_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        "DOCUMENTS_S3_ACCESS_KEY and DOCUMENTS_S3_SECRET_KEY are required when DOCUMENTS_S3_BUCKET is set"
      );
    }
    return new S3ObjectStore({
      bucket,
      region: env.DOCUMENTS_S3_REGION?.trim() || "us-east-1",
      endpoint: env.DOCUMENTS_S3_ENDPOINT?.trim() || undefined,
      accessKeyId,
      secretAccessKey,
      forcePathStyle: env.DOCUMENTS_S3_FORCE_PATH_STYLE?.trim().toLowerCase() === "true"
    });
  }

  const deployment = readDeploymentEnvironment(env);
  if (deployment === "local" || deployment === "ci") {
    const root = env.DOCUMENTS_STORAGE_DIR?.trim() || join("/tmp", "hyperion-documents");
    return new LocalMockObjectStore(root);
  }

  throw new Error("DOCUMENTS_S3_BUCKET is required outside local/ci environments");
}

export function detectContentType(bytes: Buffer): "application/pdf" | "image/png" | "image/jpeg" | null {
  if (bytes.length >= 4 && bytes.subarray(0, 4).toString("ascii") === "%PDF") {
    return "application/pdf";
  }
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

export function newDocumentId(): string {
  return randomUUID();
}
