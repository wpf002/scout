import { describe, expect, it } from "vitest";

import { clock } from "./clock";

// A fixed instant, so every expectation below is a fact about zones rather
// than about whenever the suite happened to run. 2026-07-04T16:30:45Z sits in
// northern-hemisphere summer, which is what makes the DST cases meaningful.
const SUMMER = new Date("2026-07-04T16:30:45Z");
const WINTER = new Date("2026-01-04T16:30:45Z");

describe("clock", () => {
  it("reads the time in the zone it was given, not UTC", () => {
    expect(clock("UTC", "en-US")(SUMMER).time).toBe("16:30:45");
    expect(clock("America/New_York", "en-US")(SUMMER).time).toBe("12:30:45");
    expect(clock("Asia/Tokyo", "en-US")(SUMMER).time).toBe("01:30:45");
  });

  it("labels the zone", () => {
    expect(clock("America/New_York", "en-US")(SUMMER).zone).toBe("EDT");

    // Only a handful of zones have an abbreviation in any given locale's data.
    // Tokyo in en-US is "GMT+9", not "JST" — still unambiguous, which is the
    // bar. Asserting the abbreviation here would be asserting the contents of
    // whichever ICU build the test ran against.
    expect(clock("Asia/Tokyo", "en-US")(SUMMER).zone).toMatch(/^(JST|GMT\+9)$/);
  });

  it("moves the label across a daylight-saving boundary with the digits", () => {
    const ny = clock("America/New_York", "en-US");

    // The whole reason the label comes from the same formatter as the digits:
    // in January the same wall clock is an hour behind and called something
    // else. A hardcoded label would be wrong for four months of the year.
    expect(ny(SUMMER)).toEqual({ time: "12:30:45", zone: "EDT" });
    expect(ny(WINTER)).toEqual({ time: "11:30:45", zone: "EST" });
  });

  it("renders midnight as 00, never 24", () => {
    const midnight = new Date("2026-07-04T00:00:00Z");
    expect(clock("UTC", "en-US")(midnight).time).toBe("00:00:00");

    // Some locales resolve to an h24 cycle even with hour12 off, which is the
    // case the guard in clock() exists for.
    expect(clock("UTC", "ja-JP-u-hc-h24")(midnight).time).toBe("00:00:00");
  });

  it("zero-pads every field", () => {
    const early = new Date("2026-07-04T01:02:03Z");
    expect(clock("UTC", "en-US")(early).time).toBe("01:02:03");
  });

  it("stays 24-hour in a locale that prefers 12-hour", () => {
    const afternoon = clock("UTC", "en-US")(SUMMER).time;
    expect(afternoon).toBe("16:30:45");
    expect(afternoon).not.toMatch(/AM|PM/i);
  });

  it("gives a zone label for a half-hour offset too", () => {
    const kolkata = clock("Asia/Kolkata", "en-US")(SUMMER);
    expect(kolkata.time).toBe("22:00:45");
    expect(kolkata.zone).not.toBe("");
  });
});
