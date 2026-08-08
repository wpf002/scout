import { describe, expect, it } from "vitest";
import {
  SECRET_MARKER,
  collectSecretValues,
  scrubSecrets,
} from "./secrets.js";

describe("collectSecretValues", () => {
  it("finds credential material wherever it sits in a payload", () => {
    const found = collectSecretValues([
      { password: "hunter2", email: "bob@example.com" },
      { nested: { records: [{ hashed_password: "$2y$10$abcdef" }] } },
      [{ apiKey: "sk-live-abcdef" }],
    ]);
    expect(found.sort()).toEqual([
      "$2y$10$abcdef",
      "hunter2",
      "sk-live-abcdef",
    ]);
  });

  it("ignores non-secret fields with secret-looking values", () => {
    const found = collectSecretValues([
      { email: "hunter2@example.com", title: "password reset flow" },
    ]);
    expect(found).toEqual([]);
  });

  it("ignores values too short to be credentials", () => {
    // Striking a 3-character "password" would blank those letters everywhere
    // in the report.
    expect(collectSecretValues([{ password: "abc" }])).toEqual([]);
  });

  it("handles empty and malformed payloads", () => {
    expect(collectSecretValues([])).toEqual([]);
    expect(collectSecretValues([null, undefined, 42, "text"])).toEqual([]);
  });
});

describe("scrubSecrets", () => {
  it("strikes a password typed into free text by hand", () => {
    // Scope-based redaction cannot catch this — a password is not an
    // identifier — so it is the reason this pass exists.
    const result = scrubSecrets(
      "Confirmed the creds work: hunter2 on the VPN portal.",
      ["hunter2"],
    );
    expect(result.text).not.toContain("hunter2");
    expect(result.text).toContain(SECRET_MARKER);
    expect(result.count).toBe(1);
  });

  it("strikes every occurrence", () => {
    const result = scrubSecrets("hunter2 then hunter2 again", ["hunter2"]);
    expect(result.text.includes("hunter2")).toBe(false);
  });

  it("counts distinct secrets, not occurrences", () => {
    const result = scrubSecrets("a1b2c3 a1b2c3 d4e5f6", ["a1b2c3", "d4e5f6"]);
    expect(result.count).toBe(2);
  });

  it("leaves text alone when nothing matches", () => {
    const text = "Nothing sensitive in this sentence.";
    expect(scrubSecrets(text, ["hunter2"]).text).toBe(text);
    expect(scrubSecrets(text, []).count).toBe(0);
  });
});
