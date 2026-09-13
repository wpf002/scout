import { describe, expect, it } from "vitest";

import { HttpModelClient, ModelError, modelClientFromEnv, parseJsonReply } from "./model.js";

describe("modelClientFromEnv", () => {
  it("is null for none, refuses unknown providers, and needs a key where a key is needed", () => {
    expect(modelClientFromEnv({})).toBeNull();
    expect(modelClientFromEnv({ REASON_PROVIDER: "none" })).toBeNull();
    expect(() => modelClientFromEnv({ REASON_PROVIDER: "bedrock" })).toThrow(ModelError);
    expect(() => modelClientFromEnv({ REASON_PROVIDER: "anthropic" })).toThrow(/REASON_API_KEY/);
    expect(modelClientFromEnv({ REASON_PROVIDER: "ollama" })?.provider).toBe("ollama");
  });

  it("builds provider requests as plain HTTP, without an SDK", () => {
    const anthropic = modelClientFromEnv({ REASON_PROVIDER: "anthropic", REASON_API_KEY: "k", REASON_MODEL_PLANNER: "claude-haiku-4-5-20251001" }) as HttpModelClient;
    const a = anthropic.build({ role: "planner", system: "S", user: "U" });
    expect(a.url).toBe("https://api.anthropic.com/v1/messages");
    expect((a.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
    expect(JSON.parse(a.init.body as string)).toMatchObject({ model: "claude-haiku-4-5-20251001", system: "S", messages: [{ role: "user", content: "U" }] });

    const openai = modelClientFromEnv({ REASON_PROVIDER: "openai", REASON_API_KEY: "k", REASON_BASE_URL: "https://llm.example/" }) as HttpModelClient;
    const o = openai.build({ role: "synthesis", system: "S", user: "U" });
    expect(o.url).toBe("https://llm.example/v1/chat/completions");
    expect(JSON.parse(o.init.body as string)).toMatchObject({ response_format: { type: "json_object" } });

    const ollama = modelClientFromEnv({ REASON_PROVIDER: "ollama" }) as HttpModelClient;
    expect(ollama.build({ role: "planner", system: "S", user: "U" }).url).toBe("http://127.0.0.1:11434/api/chat");
  });

  it("reads each provider's reply shape and reports a provider that fails", async () => {
    const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const anthropic = modelClientFromEnv({ REASON_PROVIDER: "anthropic", REASON_API_KEY: "k" }, reply({ content: [{ type: "text", text: '{"steps":[]}' }] }));
    expect((await anthropic?.complete({ role: "planner", system: "", user: "" }))?.text).toBe('{"steps":[]}');
    const openai = modelClientFromEnv({ REASON_PROVIDER: "openai", REASON_API_KEY: "k" }, reply({ choices: [{ message: { content: "{}" } }] }));
    expect((await openai?.complete({ role: "planner", system: "", user: "" }))?.text).toBe("{}");
    const failing = modelClientFromEnv({ REASON_PROVIDER: "ollama" }, (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch);
    await expect(failing?.complete({ role: "planner", system: "", user: "" })).rejects.toThrow(/503/);
  });
});

describe("parseJsonReply", () => {
  it("unwraps fences and prose around the object", () => {
    expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonReply('Sure! Here it is: {"a":1} hope that helps')).toEqual({ a: 1 });
    expect(() => parseJsonReply("no json here")).toThrow(ModelError);
  });
});
