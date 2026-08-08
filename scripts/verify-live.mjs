#!/usr/bin/env node
/**
 * Live upstream verification.
 *
 * The normalizers are covered by fixture tests, which pin the shape each
 * provider returns. What fixtures cannot tell you is whether the provider
 * still returns that shape today, or whether your key works. This script
 * closes that gap: it calls each configured upstream for real and reports what
 * came back.
 *
 * It is NOT part of `pnpm test` on purpose — it needs live keys, costs quota,
 * and fails when a third party has an outage, none of which belong in a suite
 * that gates commits.
 *
 * Usage:
 *   pnpm build
 *   node scripts/verify-live.mjs [domain]
 *
 * Only sources with a configured key are attempted; the rest report `skipped`.
 * Nothing here is scope-gated because nothing here is person-facing: the
 * probes use a domain (example.com by default), never an email or a username.
 */
import process from "node:process";

const DOMAIN = process.argv[2] ?? "example.com";
const API = new URL("../apps/api/dist/", import.meta.url).href;

const probes = [
  {
    id: "crtsh",
    keyEnv: null,
    load: () => import(`${API}adapters/infra/crtsh.js`),
    run: (m) => m.fetchCrtsh({ kind: "domain", value: DOMAIN }),
  },
  {
    id: "shodan",
    keyEnv: "SHODAN_API_KEY",
    load: () => import(`${API}adapters/infra/shodan.js`),
    run: (m) => m.fetchShodan({ kind: "domain", value: DOMAIN }),
  },
  {
    id: "securitytrails",
    keyEnv: "SECURITYTRAILS_API_KEY",
    load: () => import(`${API}adapters/infra/securitytrails.js`),
    run: (m) => m.fetchSecurityTrails({ kind: "domain", value: DOMAIN }),
  },
  {
    id: "censys",
    keyEnv: "CENSYS_API_KEY",
    load: () => import(`${API}adapters/infra/censys.js`),
    run: (m) => m.fetchCensys({ kind: "domain", value: DOMAIN }),
  },
  {
    id: "intelligence-x",
    keyEnv: "INTELX_API_KEY",
    load: () => import(`${API}adapters/datasets/intelx.js`),
    run: (m) => m.fetchIntelx({ kind: "domain", value: DOMAIN }),
  },
  {
    id: "opensanctions",
    keyEnv: "OPENSANCTIONS_API_KEY",
    load: () => import(`${API}adapters/datasets/opensanctions.js`),
    // A published designation, not a private individual.
    run: (m) => m.fetchOpenSanctions({ kind: "person", value: "Vladimir Putin" }),
  },
];

const results = [];

for (const probe of probes) {
  if (probe.keyEnv !== null) {
    const key = process.env[probe.keyEnv];
    if (key === undefined || key.trim().length === 0) {
      results.push({ id: probe.id, state: "skipped", detail: `${probe.keyEnv} unset` });
      continue;
    }
  }

  const startedAt = Date.now();
  try {
    const module = await probe.load();
    const observations = await probe.run(module);
    const kinds = [...new Set(observations.map((o) => o.kind))].sort();
    results.push({
      id: probe.id,
      state: "ok",
      detail: `${observations.length} observations (${kinds.join(", ") || "none"}) in ${Date.now() - startedAt}ms`,
    });
  } catch (error) {
    results.push({
      id: probe.id,
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

const pad = Math.max(...results.map((r) => r.id.length));
console.log(`\nLive upstream check — subject: ${DOMAIN}\n`);
for (const result of results) {
  const mark =
    result.state === "ok" ? "ok  " : result.state === "skipped" ? "skip" : "FAIL";
  console.log(`  ${mark}  ${result.id.padEnd(pad)}  ${result.detail}`);
}

const failed = results.filter((r) => r.state === "failed");
const ok = results.filter((r) => r.state === "ok");
console.log(
  `\n${ok.length} reachable, ${failed.length} failed, ${results.length - ok.length - failed.length} skipped.`,
);
if (failed.length > 0) {
  console.log(
    "\nA failure here means the provider changed, is down, or the key is bad —\n" +
      "not that the normalizer is wrong. Fixture tests cover the shape.",
  );
  process.exit(1);
}
