import { z } from "zod";
import type { Subject } from "@scout/sources";
import { defineCollector, type CollectMeta, type ObservationInput } from "@scout/fusion";
import { getText, UA } from "../../live/http.js";

/**
 * The open web, through Scout's own fetch path.
 *
 * One page per run: the subject domain's home page, or a path under it.
 * robots.txt is read first and obeyed; a page the site has closed to
 * crawlers is not fetched, and the run says so. No login, no cookies, no
 * headers that pretend to be a browser: Scout's user agent, one GET,
 * following redirects. What comes back is the page's own statements about
 * itself (title, description, contact details it publishes) as identifiers
 * with the page URL as provenance.
 */

export const openWebParamsSchema = z.object({
  /** Path under the subject domain. Default: the home page. */
  path: z.string().regex(/^\/[^\s]*$/, "a path starting with /").max(500).default("/"),
});

export class RobotsDisallowed extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${url} for ${UA.split("/")[0]}; the page was not fetched.`);
    this.name = "RobotsDisallowed";
  }
}

/**
 * Whether robots.txt lets Scout's agent fetch `path`. The most specific
 * matching rule wins; a rule for "*" applies when there is none for Scout;
 * no rules at all means allowed.
 */
export function robotsAllows(robots: string, path: string, agent = "Scout-OSINT"): boolean {
  const groups: Array<{ agents: string[]; rules: Array<{ allow: boolean; pattern: string }> }> = [];
  let current: (typeof groups)[number] | null = null;
  let sawRule = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (m === null) continue;
    const field = (m[1] ?? "").toLowerCase();
    const value = (m[2] ?? "").trim();
    if (field === "user-agent") {
      if (current === null || sawRule) {
        current = { agents: [], rules: [] };
        groups.push(current);
        sawRule = false;
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === "allow" || field === "disallow") && current !== null) {
      current.rules.push({ allow: field === "allow", pattern: value });
      sawRule = true;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().startsWith(a)));
  const applicable = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  let best: { allow: boolean; length: number } | null = null;
  for (const g of applicable) {
    for (const rule of g.rules) {
      if (rule.pattern === "") {
        if (!rule.allow && best === null) best = { allow: true, length: 0 };
        continue;
      }
      const re = new RegExp(`^${rule.pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*").replace(/\\\$$/, "$")}`);
      if (re.test(path) && (best === null || rule.pattern.length > best.length)) best = { allow: rule.allow, length: rule.pattern.length };
    }
  }
  return best === null ? true : best.allow;
}

export interface PageFacts {
  url: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  emails: string[];
  handles: string[];
  phones: string[];
  fetchedAt: string;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();

/** What a page says about itself. Scripts and styles are dropped before anything is read. */
export function extractFacts(url: string, html: string, fetchedAt: Date): PageFacts {
  const stripped = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(stripped)?.[1];
  const description = /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(stripped)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i.exec(stripped)?.[1];
  const text = stripped.replace(/<[^>]+>/g, " ");
  const emails = [...new Set([...text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0].toLowerCase()))].filter((e) => !/\.(png|jpg|gif|svg|webp)$/i.test(e)).slice(0, 20);
  const handles = [...new Set([...stripped.matchAll(/https?:\/\/(?:www\.)?(?:twitter\.com|x\.com|instagram\.com|linkedin\.com\/(?:in|company)|github\.com|facebook\.com)\/([A-Za-z0-9_.-]{2,60})/g)].map((m) => `@${m[1]}`))].slice(0, 20);
  const phones = [...new Set([...text.matchAll(/\+\d[\d\s().-]{7,18}\d/g)].map((m) => m[0].replace(/\s+/g, " ").trim()))].slice(0, 10);
  return {
    url,
    finalUrl: url,
    title: title === undefined ? null : decode(title).slice(0, 300) || null,
    description: description === undefined ? null : decode(description).slice(0, 500) || null,
    emails,
    handles,
    phones,
    fetchedAt: fetchedAt.toISOString(),
  };
}

export async function fetchPage(domain: string, path: string): Promise<PageFacts> {
  const origin = `https://${domain}`;
  // A missing robots.txt is "no rules"; a present one is obeyed.
  const robots = await getText(`${origin}/robots.txt`, { timeoutMs: 15_000, allowStatus: [404, 403, 410] }).catch(() => "");
  if (!robotsAllows(robots, path)) throw new RobotsDisallowed(`${origin}${path}`);
  const url = `${origin}${path}`;
  const html = await getText(url, { timeoutMs: 20_000, headers: { accept: "text/html,application/xhtml+xml" } });
  return extractFacts(url, html.slice(0, 2_000_000), new Date());
}

export function normalizePage(raw: unknown, meta: CollectMeta): ObservationInput[] {
  const page = raw as PageFacts | null;
  if (page === null || typeof page !== "object" || typeof page.url !== "string") return [];
  const domain = new URL(page.url).hostname.toLowerCase();
  return [
    {
      sourceId: openWebCollector.id,
      authorizationId: meta.authorizationId,
      collectedAt: meta.collectedAt,
      observedAt: new Date(page.fetchedAt),
      rawPayload: page,
      normalizedPayload: {
        url: page.url,
        domain,
        title: page.title,
        description: page.description,
        emails: page.emails,
        handles: page.handles,
        phones: page.phones,
      },
      position: null,
      confidenceBp: null,
      indeterminate: false,
      entityKind: "ORG" as const,
      ...(meta.caseId === undefined ? {} : { caseId: meta.caseId }),
      identifiers: [
        { kind: "DOMAIN" as const, value: domain },
        { kind: "URL" as const, value: page.url },
        ...(page.title === null ? [] : [{ kind: "NAME" as const, value: page.title }]),
        ...page.emails.map((value) => ({ kind: "EMAIL" as const, value })),
        ...page.handles.map((value) => ({ kind: "HANDLE" as const, value })),
        ...page.phones.map((value) => ({ kind: "PHONE" as const, value })),
      ],
    },
  ];
}

const base = defineCollector(
  {
    id: "open-web",
    name: "Open web page",
    sourceClass: "OPEN_WEB",
    licensingTerms:
      "Publicly served pages, fetched once with Scout's declared user agent, obeying robots.txt and the site's terms. No authentication, no cookies, no bypass of any access control; " +
      "a page closed to crawlers is not fetched and the run records why. Content is the publisher's; Scout keeps what the page states about itself, with the URL as provenance.",
    rateLimit: { perMinute: 10 },
    refreshCadenceSeconds: 24 * 60 * 60,
  },
  normalizePage,
);

export const openWebCollector = {
  ...base,
  entityKind: "ORG" as const,
  subjectRequired: true,
  paramsSchema: openWebParamsSchema,
  async fetch(input: { subject?: Subject | undefined; params?: Record<string, unknown> | undefined }) {
    if (input.subject === undefined || input.subject.kind !== "domain") {
      throw new Error("The open web collector takes a domain subject.");
    }
    const { path } = openWebParamsSchema.parse(input.params ?? {});
    return fetchPage(input.subject.value.trim().toLowerCase(), path);
  },
};
