import { createHash } from "node:crypto";
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

// One Norwegian vessel, as Kystverket publishes it: a short track whose last
// coordinate is where the ship is.
const KYSTVERKET = JSON.stringify({
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      geometry: { type: "LineString", coordinates: [[5.30, 60.39], [5.31, 60.40]] },
      properties: { mmsi: 257123456, ship_name: "MS TESTFJORD", imo: 9123456, callsign: "LATE", ship_type: 60, destination: "BERGEN", speed: 11.5, true_heading: 42, cog: 40, draught: 4.2, length: 88, date_time_utc: "2026-09-13T11:58:00Z" },
    },
  ],
});
const DIGITRAFFIC = JSON.stringify({ type: "FeatureCollection", features: [] });

const EXAMPLE_ROBOTS = "User-agent: *\nDisallow: /private/\nAllow: /\n";
const EXAMPLE_PAGE = `<html><head><title>Example &amp; Sons</title><meta name="description" content="A family firm since 1900."></head>
<body><script>var x = "hidden@nowhere.test";</script><p>Write to hello@example.org or call +44 20 7946 0958.</p><a href="https://x.com/examplesons">X</a></body></html>`;
const CLOSED_ROBOTS = "User-agent: *\nDisallow: /\n";

// Sentinel Hub: a token, one scene in the catalogue, and the process API
// answering with a tiny PNG and a TIFF header, whatever the box.
const SH_TOKEN = JSON.stringify({ access_token: "sh-test-token", expires_in: 3600 });
const SH_CATALOG = JSON.stringify({
  features: [
    { id: "S2B_MSIL2A_20260901T103629_N0511_R008_T32VKM_20260901T130000", properties: { datetime: "2026-09-01T10:36:29Z", "eo:cloud_cover": 12.4 } },
    { id: "S2A_MSIL2A_20260827T103631_N0511_R008_T32VKM_20260827T130000", properties: { datetime: "2026-08-27T10:36:31Z", "eo:cloud_cover": 3.1 } },
  ],
});
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const TIFF_STUB = Buffer.from("II*\u0000\u0008\u0000\u0000\u0000scout-test-tiff", "latin1");

const PLANET_SEARCH = JSON.stringify({
  features: [{ id: "20260902_101512_12_2455", properties: { acquired: "2026-09-02T10:15:12Z", cloud_cover: 0.08, item_type: "PSScene", satellite_id: "2455", gsd: 3.9 } }],
});
const MAXAR_SEARCH = JSON.stringify({
  features: [{ id: "10300100E1F2A300", collection: "wv03-vis", properties: { datetime: "2026-09-03T11:02:00Z", "eo:cloud_cover": 5, platform: "worldview-03", gsd: 0.31 } }],
});

/**
 * Object storage, in memory: the S3 verbs the pipeline uses, keyed by URL.
 * The signature is not checked; the store client's own tests cover that.
 */
const objects = new Map<string, { body: Uint8Array; contentType: string }>();
export function storedObjectKeys(): string[] {
  return [...objects.keys()].sort();
}
export function clearStoredObjects(): void {
  objects.clear();
}
async function s3(url: string, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  if (method === "PUT") {
    const raw = init?.body;
    const body = raw instanceof Uint8Array ? raw : typeof raw === "string" ? new TextEncoder().encode(raw) : new Uint8Array(await new Response(raw as ConstructorParameters<typeof Response>[0]).arrayBuffer());
    objects.set(url, { body, contentType: String((init?.headers as Record<string, string> | undefined)?.["content-type"] ?? "application/octet-stream") });
    return new Response(null, { status: 200 });
  }
  const hit = objects.get(url);
  if (hit === undefined) return new Response("NoSuchKey", { status: 404 });
  if (method === "HEAD") return new Response(null, { status: 200, headers: { "content-length": String(hit.body.byteLength), "content-type": hit.contentType } });
  return new Response(hit.body, { status: 200, headers: { "content-type": hit.contentType } });
}

const ROUTES: Array<{ match: RegExp; reply: () => Response }> = [
  { match: /^https:\/\/kystdatahuset\.no\//, reply: () => text(KYSTVERKET, "application/json") },
  { match: /^https:\/\/meri\.digitraffic\.fi\//, reply: () => text(DIGITRAFFIC, "application/json") },
  { match: /^https:\/\/example\.org\/robots\.txt$/, reply: () => text(EXAMPLE_ROBOTS, "text/plain") },
  { match: /^https:\/\/example\.org\/$/, reply: () => text(EXAMPLE_PAGE, "text/html") },
  { match: /^https:\/\/closed\.example\/robots\.txt$/, reply: () => text(CLOSED_ROBOTS, "text/plain") },
  { match: /^https:\/\/services\.sentinel-hub\.com\/auth\//, reply: () => text(SH_TOKEN, "application/json") },
  { match: /^https:\/\/services\.sentinel-hub\.com\/api\/v1\/catalog\//, reply: () => text(SH_CATALOG, "application/json") },
  { match: /^https:\/\/api\.planet\.com\/data\/v1\/quick-search/, reply: () => text(PLANET_SEARCH, "application/json") },
  { match: /^https:\/\/api\.maxar\.com\/discovery\/v1\/search/, reply: () => text(MAXAR_SEARCH, "application/json") },
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

/**
 * The recognition service, as far as the suite is concerned: a
 * deterministic embedding from the media bytes and the same cosine
 * arithmetic the service uses, so identical media match, different media
 * do not, and two identical templates make a close call.
 */
function fakeEmbedding(modality: string, media: Uint8Array): number[] {
  const digest = createHash("sha256").update(modality).update(media).digest();
  const v: number[] = [];
  for (let i = 0; i < 16; i += 1) v.push((digest[i * 2] as number) - 128 + ((digest[i * 2 + 1] as number) - 128) / 256);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}
function fakeRecognition(path: string, body: string): Response {
  const req = JSON.parse(body) as Record<string, unknown>;
  const modality = String(req["modality"]);
  if (path === "/embed") {
    const media = Buffer.from(String(req["media_b64"]), "base64");
    return text(JSON.stringify({ model: "stub-embedder (not a recogniser)", dims: 16, embedding: fakeEmbedding(modality, media), media_hash: createHash("sha256").update(media).digest("hex") }), "application/json");
  }
  const media = Buffer.from(String(req["probe_media_b64"]), "base64");
  const probe = fakeEmbedding(modality, media);
  const candidates = (req["candidates"] as Array<{ enrollment_id: string; embedding: number[] }>) ?? [];
  const distance = (e: number[]) => Math.round(Math.max(0, Math.min(1, 1 - probe.reduce((s, x, i) => s + x * (e[i] as number), 0))) * 10_000);
  const matches = candidates.map((c) => ({ enrollment_id: c.enrollment_id, distance_bp: distance(c.embedding) })).sort((a, b) => a.distance_bp - b.distance_bp || a.enrollment_id.localeCompare(b.enrollment_id)).slice(0, Number(req["top_n"] ?? 5));
  const threshold = Number(req["threshold_bp"]);
  const margin = Number(req["margin_bp"] ?? 500);
  let decision = "INDETERMINATE";
  let reason = "the gallery has no active template for this modality; nothing was compared";
  const best = matches[0];
  if (best !== undefined) {
    if (best.distance_bp > threshold) { decision = "NO_MATCH"; reason = "outside the threshold"; }
    else if (matches[1] !== undefined && (matches[1].distance_bp - best.distance_bp) < margin) { decision = "INDETERMINATE"; reason = "top two inside the ambiguity margin"; }
    else { decision = "MATCH"; reason = "inside the threshold"; }
  }
  return text(JSON.stringify({ model: "stub-embedder (not a recogniser)", probe_hash: createHash("sha256").update(media).digest("hex"), compared: candidates.length, matches, decision, reason }), "application/json");
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
  if (/^http:\/\/127\.0\.0\.1:9000\//.test(url)) return s3(url, init);
  const recognition = /^http:\/\/127\.0\.0\.1:8200(\/embed|\/compare)$/.exec(url);
  if (recognition !== null && typeof init?.body === "string") return fakeRecognition(recognition[1] as string, init.body);
  // The process API answers in the format the caller accepted.
  if (/^https:\/\/services\.sentinel-hub\.com\/api\/v1\/process$/.test(url)) {
    const accept = String((init?.headers as Record<string, string> | undefined)?.["accept"] ?? "image/tiff");
    return new Response(accept === "image/png" ? PNG_1PX : TIFF_STUB, { status: 200, headers: { "content-type": accept } });
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
