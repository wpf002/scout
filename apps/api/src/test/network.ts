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

const ROUTES: Array<{ match: RegExp; reply: () => Response }> = [
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

const offline: typeof fetch = async (input, _init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

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
