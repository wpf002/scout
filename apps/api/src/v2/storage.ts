import { createHash, createHmac } from "node:crypto";

/**
 * Object storage over the S3 API, signed by hand.
 *
 * Three verbs are all the imagery pipeline needs (put, get, head), and
 * Signature Version 4 for three verbs is a page of code. That page is
 * cheaper to own than an SDK whose surface is a thousand times larger and
 * whose version churn Scout would inherit. MinIO locally, R2 or any
 * S3-compatible store in production, selected by S3_ENDPOINT.
 */

export interface StorageConfig {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean;
}

export interface StoredObject {
  body: Uint8Array;
  contentType: string | null;
}

export class StorageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

export function storageConfigFromEnv(env: NodeJS.ProcessEnv = process.env): StorageConfig | null {
  const endpoint = env["S3_ENDPOINT"]?.trim() ?? "";
  const accessKey = env["S3_ACCESS_KEY"]?.trim() ?? "";
  const secretKey = env["S3_SECRET_KEY"]?.trim() ?? "";
  if (endpoint === "" || accessKey === "" || secretKey === "") return null;
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    region: env["S3_REGION"]?.trim() || "us-east-1",
    accessKey,
    secretKey,
    forcePathStyle: (env["S3_FORCE_PATH_STYLE"] ?? "true").trim().toLowerCase() !== "false",
  };
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string): Buffer => createHmac("sha256", key).update(data).digest();
const EMPTY_HASH = sha256("");

/** RFC 3986 encoding per path segment, which is what the canonical URI wants. */
const encodeKey = (key: string): string =>
  key
    .split("/")
    .map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

export class ObjectStore {
  constructor(
    private readonly config: StorageConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
  ) {}

  private target(bucket: string, key: string): { url: URL; host: string; path: string } {
    const base = new URL(this.config.endpoint);
    const path = this.config.forcePathStyle ? `/${bucket}/${encodeKey(key)}` : `/${encodeKey(key)}`;
    const host = this.config.forcePathStyle ? base.host : `${bucket}.${base.host}`;
    const url = new URL(`${base.protocol}//${host}${path}`);
    return { url, host, path };
  }

  /** The signed request, exposed for tests: no network needed to check a signature. */
  sign(method: "PUT" | "GET" | "HEAD", bucket: string, key: string, body: Uint8Array | null, contentType: string | null, now: Date = new Date()): { url: string; init: RequestInit } {
    const { url, host, path } = this.target(bucket, key);
    const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body === null ? EMPTY_HASH : sha256(body);

    const headers: Record<string, string> = {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (contentType !== null) headers["content-type"] = contentType;
    const signedHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaderNames.map((h) => `${h}:${headers[h]?.trim()}\n`).join("");
    const signedHeaders = signedHeaderNames.join(";");
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const kDate = hmac(`AWS4${this.config.secretKey}`, dateStamp);
    const kRegion = hmac(kDate, this.config.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");

    const { host: _host, ...sent } = headers;
    return {
      url: url.toString(),
      init: {
        method,
        headers: {
          ...sent,
          authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
        ...(body === null ? {} : { body }),
      },
    };
  }

  async put(bucket: string, key: string, body: Uint8Array, contentType: string): Promise<void> {
    const { url, init } = this.sign("PUT", bucket, key, body, contentType);
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new StorageError(response.status, `PUT ${bucket}/${key} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }

  async head(bucket: string, key: string): Promise<{ size: number; contentType: string | null } | null> {
    const { url, init } = this.sign("HEAD", bucket, key, null, null);
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(20_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new StorageError(response.status, `HEAD ${bucket}/${key} answered ${response.status}`);
    return { size: Number(response.headers.get("content-length") ?? "0"), contentType: response.headers.get("content-type") };
  }

  async get(bucket: string, key: string): Promise<StoredObject | null> {
    const { url, init } = this.sign("GET", bucket, key, null, null);
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(60_000) });
    if (response.status === 404) return null;
    if (!response.ok) throw new StorageError(response.status, `GET ${bucket}/${key} answered ${response.status}`);
    return { body: new Uint8Array(await response.arrayBuffer()), contentType: response.headers.get("content-type") };
  }
}

let shared: ObjectStore | null | undefined;

/** The store the environment describes, or null when S3_* is not set. */
export function objectStore(): ObjectStore | null {
  if (shared === undefined) {
    const config = storageConfigFromEnv();
    shared = config === null ? null : new ObjectStore(config);
  }
  return shared;
}

export function resetObjectStore(): void {
  shared = undefined;
}

export const TILES_BUCKET = (): string => process.env["S3_BUCKET_TILES"]?.trim() || "scout-tiles";
