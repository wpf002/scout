/**
 * Bundles the dashboard into one self-contained HTML file.
 *
 * The output has no external references at all — no chunk loading, no fonts,
 * no API — so it runs from a file:// URL, a static host, or an email
 * attachment. That is the whole point: the UI is the product, and there are
 * plenty of situations where the server cannot be reached but the UI still
 * has to be seen.
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const web = resolve(here, "..");
const out = resolve(here, "dist");
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [resolve(here, "main.tsx")],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  write: false,
  legalComments: "none",
  define: {
    "process.env.NODE_ENV": '"production"',
    "process.env.NEXT_PUBLIC_API_URL": '""',
  },
  alias: {
    // The two Next modules the app touches, replaced at the module boundary so
    // the page components themselves stay untouched.
    "next/link": resolve(here, "shims/link.tsx"),
    "next/navigation": resolve(here, "shims/navigation.ts"),
    // `apps/web` has no dependency on the workspace packages — it carries its
    // own view types — so point at their build output directly. These are the
    // real gate, registry and graph, not copies.
    "@scout/scope": resolve(web, "../../packages/scope/dist/index.js"),
    "@scout/sources": resolve(web, "../../packages/sources/dist/index.js"),
    "@scout/graph": resolve(web, "../../packages/graph/dist/index.js"),
    "@": resolve(web, "src"),
  },
  loader: { ".css": "css" },
  outdir: out,
});

const js = result.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "";
const css = result.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";

const html = `<title>Scout — the dashboard, running in this page</title>
<style>${css}</style>
<style>
  /* The banner. Deliberately not styled as a warning: nothing here is broken,
     one layer is substituted, and the page says which. */
  .demo-banner {
    max-width: 1180px;
    margin: 0 auto 4px;
    padding: 12px 24px 0;
  }
  .demo-banner .inner {
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--brand);
    border-radius: var(--radius);
    padding: 11px 14px;
    font-size: 12.5px;
    color: var(--text-dim);
    background: var(--bg-raised);
  }
  .demo-banner strong { color: var(--text); }
</style>

<div class="demo-banner">
  <div class="inner">
    <strong>This is the real dashboard, with the network swapped out.</strong>
    The components, the scope gate, the source registry and the entity graph are
    the actual packages — an out-of-scope subject is refused here by the same
    code that refuses it in production, and the denial lands in the audit log.
    Only the calls to upstream providers are fixtures. Everything is in memory,
    so a reload starts over.
  </div>
</div>

<div id="root"></div>
<script>${js}</script>
`;

writeFileSync(resolve(out, "scout-demo.html"), html);
console.log(
  `wrote demo/dist/scout-demo.html — ${(html.length / 1024).toFixed(0)} KB ` +
    `(js ${(js.length / 1024).toFixed(0)} KB, css ${(css.length / 1024).toFixed(0)} KB)`,
);
