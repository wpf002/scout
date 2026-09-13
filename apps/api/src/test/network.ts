/**
 * The suite does not talk to the internet.
 *
 * Several tests exercised the infrastructure sweep by actually calling crt.sh,
 * CertSpotter and HackerTarget. That made them slow, made them fail whenever a
 * public service was having a bad afternoon, and meant the assertions drifted
 * with whatever those services happened to return — one of them still expected
 * a `securitytrails` adapter that was removed from the codebase.
 *
 * `fetch` is replaced with a router over canned responses for the hosts the
 * sweep reaches. Anything unrouted gets a 503, which is a state every adapter
 * already handles: it reports the source as errored and the sweep carries on.
 * So a test that reaches for a new upstream fails on its assertions rather than
 * hanging for thirty seconds, and no test can pass because a stranger's server
 * was up.
 *
 * DNS is left alone. `resolveAddresses` uses the resolver directly rather than
 * fetch, and stubbing it would mean stubbing node's dns module for no gain —
 * it is fast, and nothing asserts on which address came back.
 */

const CRTSH = JSON.stringify([
  {
    common_name: "example.com",
    name_value: "example.com\nwww.example.com\napi.example.com",
    issuer_name: "C=US, O=Let's Encrypt, CN=R3",
    serial_number: "04a1b2c3",
    not_before: "2026-06-01T00:00:00",
    not_after: "2026-09-01T00:00:00",
  },
  {
    common_name: "*.example.com",
    name_value: "*.example.com\nwww.example.com",
    issuer_name: "C=US, O=DigiCert Inc, CN=DigiCert TLS RSA CA G1",
    serial_number: "04d4e5f6",
    not_before: "2026-05-01T00:00:00",
    not_after: "2026-08-01T00:00:00",
  },
]);

// `host,address` per line, which is the whole format.
const HACKERTARGET = [
  "www.example.com,93.184.216.34",
  "api.example.com,93.184.216.35",
  "mail.example.com,93.184.216.36",
].join("\n");

const CERTSPOTTER = JSON.stringify([
  {
    dns_names: ["example.com", "www.example.com", "cdn.example.com"],
    not_before: "2026-06-01T00:00:00Z",
    not_after: "2026-09-01T00:00:00Z",
    issuer: { name: "C=US, O=Let's Encrypt, CN=R3" },
  },
]);

const RAPIDDNS = `<table><tbody>
<tr><td>www.example.com</td><td>93.184.216.34</td><td>A</td></tr>
<tr><td>api.example.com</td><td>93.184.216.35</td><td>A</td></tr>
</tbody></table>`;

const INTERNETDB = JSON.stringify({
  ip: "93.184.216.34",
  ports: [80, 443],
  hostnames: ["www.example.com"],
  cpes: [],
  tags: [],
  vulns: [],
});

function text(body: string, type: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": type } });
}

// OpenSky's positional state vectors: 0 icao24, 1 callsign, 2 origin country,
// 5 longitude, 6 latitude, 7 baro altitude, 8 on ground, 9 velocity, 10 track,
// 14 squawk. Two aircraft, one airline and one private.
const OPENSKY = JSON.stringify({
  time: 1789300000,
  states: [
    ["abc123", "UAL123  ", "United States", 1789299990, 1789299995, -122.4, 37.6, 3000.0, false, 200.0, 90.0, 0, null, 3100.0, "1200", false, 0],
    ["4b1805", "N123AB  ", "United States", 1789299990, 1789299995, -73.9, 40.7, 1500.0, false, 120.0, 180.0, 0, null, 1600.0, null, false, 0],
  ],
});

// Community ADS-B feeds answer with an empty aircraft list in the suite.
const ADSB_EMPTY = JSON.stringify({ ac: [] });

// Three registrants, the whole registry as far as the suite is concerned.
const SEC_TICKERS = JSON.stringify({
  "0": { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." },
  "1": { cik_str: 789019, ticker: "MSFT", title: "Microsoft Corp" },
  "2": { cik_str: 1018724, ticker: "AMZN", title: "Amazon Com Inc" },
});

const ROUTES: Array<{ match: RegExp; reply: () => Response }> = [
  { match: /^https:\/\/opensky-network\.org\//, reply: () => text(OPENSKY, "application/json") },
  { match: /^https:\/\/(api\.adsb\.lol|opendata\.adsb\.fi)\//, reply: () => text(ADSB_EMPTY, "application/json") },
  { match: /^https:\/\/www\.sec\.gov\/files\/company_tickers\.json/, reply: () => text(SEC_TICKERS, "application/json") },
  { match: /^https:\/\/crt\.sh\//, reply: () => text(CRTSH, "application/json") },
  {
    match: /^https:\/\/api\.hackertarget\.com\//,
    reply: () => text(HACKERTARGET, "text/plain"),
  },
  {
    match: /^https:\/\/api\.certspotter\.com\//,
    reply: () => text(CERTSPOTTER, "application/json"),
  },
  { match: /^https:\/\/rapiddns\.io\//, reply: () => text(RAPIDDNS, "text/html") },
  {
    match: /^https:\/\/internetdb\.shodan\.io\//,
    reply: () => text(INTERNETDB, "application/json"),
  },
];

/**
 * The resolution service, as far as the suite is concerned.
 *
 * Not the algorithm: that is Splink and lives in Python with its own tests
 * and evaluation harness. This answers the API with something shaped exactly
 * like the service so that persistence, review, pinning and supersession can
 * be tested without a second process: pairs sharing a hard identifier match,
 * pairs sharing only a name go to review, pins outrank both, and a component
 * with a non-match inside is disputed.
 */
function fakeResolve(body: string): Response {
  const req = JSON.parse(body) as {
    authorization_id: string;
    entity_kind: string;
    observations: { id: string; identifiers: { kind: string; value: string }[] }[];
    adjudications: { left: string; right: string; decision: string }[];
  };
  const HARD = new Set(["ICAO_HEX", "TAIL_NUMBER", "MMSI", "IMO", "DOCUMENT_NO", "EMAIL", "PHONE", "DEVICE_ID"]);
  // The stand-in normalizes the way the service does for the kinds the suite
  // uses: phones to digits, everything else case-folded without spaces.
  const norm = (kind: string, v: string) =>
    kind === "PHONE" ? v.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1") : v.toLowerCase().replace(/[\s-]/g, "");
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const byHard = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  for (const o of req.observations) {
    for (const i of o.identifiers) {
      const bucket = HARD.has(i.kind) ? byHard : i.kind === "NAME" ? byName : null;
      if (bucket === null) continue;
      const k = `${i.kind}:${norm(i.kind, i.value)}`;
      bucket.set(k, [...(bucket.get(k) ?? []), o.id]);
    }
  }
  const decisions = new Map<string, { left: string; right: string; score_bp: number | null; decision: string; blocking_key: string; features: Record<string, unknown>; pinned: boolean }>();
  const pair = (ids: string[], score: number, decision: string, blocking: string) => {
    for (let i = 0; i < ids.length; i += 1) for (let j = i + 1; j < ids.length; j += 1) {
      const [l, r] = ids[i]! < ids[j]! ? [ids[i]!, ids[j]!] : [ids[j]!, ids[i]!];
      if (!decisions.has(key(l, r))) decisions.set(key(l, r), { left: l, right: r, score_bp: score, decision, blocking_key: blocking, features: { stub: true }, pinned: false });
    }
  };
  for (const [k, ids] of byHard) pair([...new Set(ids)], 9900, "MATCH", `exact:${k.split(":")[0]}`);
  for (const [, ids] of byName) pair([...new Set(ids)], 8000, "REVIEW", "exact:name");
  for (const a of req.adjudications) {
    const k = key(a.left, a.right);
    const existing = decisions.get(k);
    const [l, r] = a.left < a.right ? [a.left, a.right] : [a.right, a.left];
    decisions.set(k, { left: l, right: r, score_bp: existing?.score_bp ?? null, decision: a.decision, blocking_key: existing?.blocking_key ?? "adjudication", features: { stub: true }, pinned: true });
  }
  const parent = new Map(req.observations.map((o) => [o.id, o.id]));
  const find = (x: string): string => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x)!)!); x = parent.get(x)!; } return x; };
  for (const d of decisions.values()) if (d.decision === "MATCH") parent.set(find(d.left), find(d.right));
  const groups = new Map<string, string[]>();
  for (const o of req.observations) groups.set(find(o.id), [...(groups.get(find(o.id)) ?? []), o.id]);
  const clusters = [...groups.values()].map((members) => {
    members.sort();
    const conflicts = [...decisions.values()].filter((d) => d.decision === "NON_MATCH" && members.includes(d.left) && members.includes(d.right)).map((d) => [d.left, d.right]);
    const status = conflicts.length > 0 ? "DISPUTED" : members.length > 1 ? "RESOLVED" : "PROVISIONAL";
    const first = req.observations.find((o) => o.id === members[0]);
    const label = first?.identifiers.find((i) => i.kind === "NAME")?.value ?? first?.identifiers[0]?.value ?? members[0]!;
    return { members, status, pending_review: 0, conflicts, label };
  }).sort((a, b) => a.members[0]!.localeCompare(b.members[0]!));
  const all = [...decisions.values()];
  const counts = {
    observations: req.observations.length, pairs: all.length,
    match: all.filter((d) => d.decision === "MATCH").length, non_match: all.filter((d) => d.decision === "NON_MATCH").length,
    review: all.filter((d) => d.decision === "REVIEW").length, indeterminate: all.filter((d) => d.decision === "INDETERMINATE").length,
    pinned: all.filter((d) => d.pinned).length, entities: clusters.length,
    resolved: clusters.filter((c) => c.status === "RESOLVED").length, provisional: clusters.filter((c) => c.status === "PROVISIONAL").length,
    disputed: clusters.filter((c) => c.status === "DISPUTED").length,
  };
  return text(JSON.stringify({
    authorization_id: req.authorization_id, entity_kind: req.entity_kind, model_version: "stub-resolver-1",
    normalization_version: "stub-1", thresholds: { match_bp: 9500, review_bp: 7000 }, decisions: all, clusters, counts,
  }), "application/json");
}

const offline: typeof fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  if (/^http:\/\/127\.0\.0\.1:8100\/resolve$/.test(url) && typeof init?.body === "string") {
    return fakeResolve(init.body);
  }

  const route = ROUTES.find((entry) => entry.match.test(url));
  if (route !== undefined) return route.reply();

  // Not a throw. Adapters distinguish "the upstream said no" from "the code
  // broke", and the first is what an unrouted host should look like.
  return new Response(`Scout test suite does not reach ${url}`, {
    status: 503,
    headers: { "content-type": "text/plain" },
  });
};

globalThis.fetch = offline;
