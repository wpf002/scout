import { describe, expect, it } from "vitest";

/**
 * CelesTrak's rate limit, pinned.
 *
 * These are not tests of orbital mechanics — they are tests of politeness.
 * CelesTrak firewalls an address that accumulates fifty HTTP errors in a
 * two-hour window, and the label pass is thirty-five requests. Getting this
 * wrong does not degrade a layer; it gets the address banned and turns a
 * two-hour wait into a manual unblock request.
 */

/**
 * The refusal, reproduced verbatim from a live response. It arrives with an
 * HTTP 403, and an unknown group arrives with an HTTP 200 — which is why
 * neither can be detected from the status code alone.
 */
const REFUSAL =
  "GP data has not updated since your last successful\ndownload of GROUP=active at 2026-08-31 23:16:25 UTC.\nData is updated once every 2 hours.";

const UNKNOWN_GROUP =
  'Invalid query: "GROUP=noaa&FORMAT=tle" (GROUP=noaa not found)';

const REAL_TLE = `STARLINK-1008
1 44714U 19074B   26243.50000000  .00002182  00000+0  16967-3 0  9995
2 44714  53.0542 108.6712 0001404  85.9425 274.1720 15.06391927345678`;

/** The parser and the two sentinels, extracted so they can be tested alone. */
function isRefusal(body: string): boolean {
  return body.startsWith("GP data has not updated");
}

function isUnknownGroup(body: string): boolean {
  return body.startsWith("Invalid query");
}

function parseTle(body: string): Array<{ name: string; noradId: string }> {
  const lines = body.split("\n").map((l) => l.trimEnd());
  const out: Array<{ name: string; noradId: string }> = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = (lines[i] ?? "").trim();
    const line1 = lines[i + 1] ?? "";
    const line2 = lines[i + 2] ?? "";
    if (!line1.startsWith("1 ") || !line2.startsWith("2 ")) continue;
    out.push({ name, noradId: line1.slice(2, 7).trim() });
  }
  return out;
}

describe("CelesTrak sentinels", () => {
  it("recognises the rate-limit refusal", () => {
    expect(isRefusal(REFUSAL)).toBe(true);
    expect(isRefusal(REAL_TLE)).toBe(false);
  });

  it("recognises an unknown group, which arrives as HTTP 200", () => {
    // This is the one that bites: a status-code check passes, and the error
    // sentence is then ingested as a satellite name.
    expect(isUnknownGroup(UNKNOWN_GROUP)).toBe(true);
    expect(parseTle(UNKNOWN_GROUP)).toEqual([]);
  });

  it("refuses to parse either sentinel into a satellite", () => {
    expect(parseTle(REFUSAL)).toEqual([]);
    expect(parseTle(UNKNOWN_GROUP)).toEqual([]);
  });

  it("parses a real element set", () => {
    expect(parseTle(REAL_TLE)).toEqual([
      { name: "STARLINK-1008", noradId: "44714" },
    ]);
  });

  it("ignores a trailing partial record rather than half-reading it", () => {
    // A truncated download must not become a satellite at a truncated
    // coordinate.
    expect(parseTle(`${REAL_TLE}\nSTARLINK-1009\n1 44715U 19074C`)).toHaveLength(1);
  });
});

describe("the circuit breaker", () => {
  /** The behaviour under test: one refusal abandons the rest of the pass. */
  function labelPass(bodies: string[]): { requests: number } {
    let refused = false;
    let requests = 0;
    for (const body of bodies) {
      if (refused) break;
      requests += 1;
      if (isRefusal(body)) refused = true;
    }
    return { requests };
  }

  it("stops the pass at the first refusal", () => {
    const groups = [REAL_TLE, REAL_TLE, REFUSAL, ...Array(32).fill(REAL_TLE)];
    // Three requests, not thirty-five. The difference is the error budget.
    expect(labelPass(groups).requests).toBe(3);
  });

  it("stays far inside CelesTrak's fifty-error window", () => {
    const allRefused: string[] = Array(35).fill(REFUSAL);
    expect(labelPass(allRefused).requests).toBe(1);
  });

  it("does not stop for an unknown group, which is not a refusal", () => {
    // A dead group name costs its own label and nothing else — it does not
    // mean the window is shut.
    const groups = [REAL_TLE, UNKNOWN_GROUP, REAL_TLE];
    expect(labelPass(groups).requests).toBe(3);
  });
});
