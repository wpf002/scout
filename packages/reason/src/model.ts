/**
 * The model seam.
 *
 * Scout talks to a language model through this interface and nothing else.
 * The providers behind it are plain HTTPS calls written here; no vendor
 * SDK is installed, so swapping the provider is an environment variable and
 * the calling code does not change. A provider of "none" is a first-class
 * state: the planner and the synthesiser have rule-based paths that need no
 * model at all, and the tests run on those.
 *
 * Every request asks for JSON and gets a string back; the caller parses
 * and validates it. The model's output is never executed, only parsed.
 */

export interface ModelRequest {
  /** Which role the call plays; each can be a different model. */
  role: "planner" | "synthesis";
  system: string;
  user: string;
  maxTokens?: number;
}

export interface ModelResponse {
  text: string;
  model: string;
  provider: string;
}

export interface ModelClient {
  readonly provider: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

export const PROVIDERS = ["anthropic", "openai", "ollama", "none"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface ModelEnv {
  REASON_PROVIDER?: string | undefined;
  REASON_MODEL_PLANNER?: string | undefined;
  REASON_MODEL_SYNTHESIS?: string | undefined;
  REASON_API_KEY?: string | undefined;
  REASON_BASE_URL?: string | undefined;
}

export class ModelError extends Error {
  readonly provider: string;
  constructor(provider: string, message: string) {
    super(message);
    this.name = "ModelError";
    this.provider = provider;
  }
}

type Fetch = typeof fetch;
const TIMEOUT_MS = 30_000;

const DEFAULT_MODELS: Record<Exclude<Provider, "none">, { planner: string; synthesis: string }> = {
  anthropic: { planner: "claude-haiku-4-5-20251001", synthesis: "claude-sonnet-5" },
  openai: { planner: "gpt-4o-mini", synthesis: "gpt-4o" },
  ollama: { planner: "llama3.1", synthesis: "llama3.1" },
};

/**
 * Build the client the environment describes, or null for "none". An
 * unknown provider name is an error at startup rather than a silent
 * fallback to rules: an operator who set it wanted a model.
 */
export function modelClientFromEnv(env: ModelEnv, fetchImpl: Fetch = fetch): ModelClient | null {
  const provider = (env.REASON_PROVIDER ?? "none").trim().toLowerCase();
  if (provider === "" || provider === "none") return null;
  if (!PROVIDERS.includes(provider as Provider)) {
    throw new ModelError(provider, `REASON_PROVIDER=${provider} is not one of ${PROVIDERS.join(", ")}.`);
  }
  const p = provider as Exclude<Provider, "none">;
  const models = {
    planner: env.REASON_MODEL_PLANNER?.trim() || DEFAULT_MODELS[p].planner,
    synthesis: env.REASON_MODEL_SYNTHESIS?.trim() || DEFAULT_MODELS[p].synthesis,
  };
  const key = env.REASON_API_KEY?.trim() ?? "";
  if (p !== "ollama" && key === "") throw new ModelError(p, `REASON_PROVIDER=${p} needs REASON_API_KEY.`);
  const base = (env.REASON_BASE_URL?.trim() || DEFAULT_BASE[p]).replace(/\/$/, "");
  return new HttpModelClient(p, base, key, models, fetchImpl);
}

const DEFAULT_BASE: Record<Exclude<Provider, "none">, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com",
  ollama: "http://127.0.0.1:11434",
};

export class HttpModelClient implements ModelClient {
  constructor(
    readonly provider: Exclude<Provider, "none">,
    private readonly base: string,
    private readonly key: string,
    private readonly models: { planner: string; synthesis: string },
    private readonly fetchImpl: Fetch,
  ) {}

  /** The exact HTTP request a call would make; exposed so tests can check it without a network. */
  build(request: ModelRequest): { url: string; init: RequestInit; model: string } {
    const model = this.models[request.role];
    const maxTokens = request.maxTokens ?? 1_500;
    if (this.provider === "anthropic") {
      return {
        model,
        url: `${this.base}/v1/messages`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": this.key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: maxTokens, system: request.system, messages: [{ role: "user", content: request.user }] }),
        },
      };
    }
    if (this.provider === "openai") {
      return {
        model,
        url: `${this.base}/v1/chat/completions`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            response_format: { type: "json_object" },
            messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }],
          }),
        },
      };
    }
    return {
      model,
      url: `${this.base}/api/chat`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: false, format: "json", messages: [{ role: "system", content: request.system }, { role: "user", content: request.user }] }),
      },
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const { url, init, model } = this.build(request);
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (caught) {
      throw new ModelError(this.provider, `The model provider did not answer: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
    if (!response.ok) throw new ModelError(this.provider, `The model provider answered ${response.status}.`);
    const body = (await response.json()) as unknown;
    const text = extractText(this.provider, body);
    if (text === null) throw new ModelError(this.provider, "The model provider's response carried no text.");
    return { text, model, provider: this.provider };
  }
}

function extractText(provider: Exclude<Provider, "none">, body: unknown): string | null {
  const b = body as Record<string, unknown>;
  if (provider === "anthropic") {
    const content = b["content"];
    if (!Array.isArray(content)) return null;
    const parts = content.filter((c): c is { type: string; text: string } => typeof c === "object" && c !== null && (c as { type?: unknown }).type === "text");
    return parts.length === 0 ? null : parts.map((p) => p.text).join("");
  }
  if (provider === "openai") {
    const choices = b["choices"];
    const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } } | undefined) : undefined;
    return typeof first?.message?.content === "string" ? first.message.content : null;
  }
  const message = b["message"] as { content?: unknown } | undefined;
  return typeof message?.content === "string" ? message.content : null;
}

/**
 * Pull the first JSON object out of a model's reply. Models wrap JSON in
 * prose and fences no matter what they're asked; the parse is strict, the
 * unwrapping is not.
 */
export function parseJsonReply(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) throw new ModelError("parse", "The model's reply held no JSON object.");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}
