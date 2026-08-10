import { beforeEach, describe, expect, it } from "vitest";
import {
  activeTrip,
  classifyFailure,
  clearBreakers,
  recordFailure,
  recordSuccess,
  tripMessage,
} from "./breaker.js";

const NOW = 1_800_000_000_000;

beforeEach(() => clearBreakers());

describe("classifying a failure", () => {
  it("reads quota and rate-limit refusals as quota", () => {
    expect(classifyFailure("API count exceeded - Increase Quota")).toBe("quota");
    expect(classifyFailure("CertSpotter rate limit reached")).toBe("quota");
    expect(classifyFailure("HTTP 429 Too Many Requests")).toBe("quota");
  });

  it("reads everything else as an outage", () => {
    expect(classifyFailure("crt.sh responded 502")).toBe("upstream");
    expect(classifyFailure("fetch failed")).toBe("upstream");
  });
});

describe("tripping", () => {
  it("trips immediately on a quota refusal", () => {
    // Self-reported and unambiguous — asking twice more only spends more of
    // the allowance that has already run out.
    const trip = recordFailure("hackertarget", "API count exceeded", NOW);
    expect(trip?.reason).toBe("quota");
    expect(activeTrip("hackertarget", NOW)).not.toBeNull();
  });

  it("tolerates isolated outages before tripping", () => {
    expect(recordFailure("crtsh", "responded 502", NOW)).toBeNull();
    expect(recordFailure("crtsh", "responded 502", NOW)).toBeNull();
    expect(activeTrip("crtsh", NOW)).toBeNull();

    expect(recordFailure("crtsh", "responded 502", NOW)?.reason).toBe(
      "upstream",
    );
    expect(activeTrip("crtsh", NOW)).not.toBeNull();
  });

  it("gives a quota a longer rest than an outage", () => {
    const quota = recordFailure("a", "quota exceeded", NOW);
    recordFailure("b", "boom", NOW);
    recordFailure("b", "boom", NOW);
    const outage = recordFailure("b", "boom", NOW);

    expect(quota).not.toBeNull();
    expect(outage).not.toBeNull();
    expect(quota!.until).toBeGreaterThan(outage!.until);
  });

  it("expires the trip on its own deadline", () => {
    const trip = recordFailure("hackertarget", "quota exceeded", NOW);
    expect(activeTrip("hackertarget", trip!.until - 1)).not.toBeNull();
    expect(activeTrip("hackertarget", trip!.until)).toBeNull();
  });

  it("forgets the failure run once the source works again", () => {
    recordFailure("crtsh", "responded 502", NOW);
    recordFailure("crtsh", "responded 502", NOW);
    recordSuccess("crtsh");

    // The counter resets, so two old failures plus one new must not trip it.
    expect(recordFailure("crtsh", "responded 502", NOW)).toBeNull();
    expect(activeTrip("crtsh", NOW)).toBeNull();
  });

  it("keeps sources independent", () => {
    recordFailure("hackertarget", "quota exceeded", NOW);
    expect(activeTrip("certspotter", NOW)).toBeNull();
  });
});

describe("what the operator is told", () => {
  it("names the cause and when it will be retried", () => {
    const trip = recordFailure(
      "hackertarget",
      "API count exceeded - Increase Quota with Membership",
      NOW,
    );
    const message = tripMessage("HackerTarget", trip!, NOW);

    expect(message).toContain("HackerTarget");
    expect(message).toContain("spent its free quota");
    expect(message).toContain("60 min");
    // The upstream's own words are kept — they are the actionable part.
    expect(message).toContain("Increase Quota with Membership");
  });

  it("never reports less than a minute remaining", () => {
    const trip = recordFailure("x", "quota", NOW);
    expect(tripMessage("X", trip!, trip!.until - 1)).toContain("1 min");
  });
});
