import { describe, expect, it } from "vitest";
import { allowedHostForTest } from "./routes/tiles.js";

/**
 * The tile proxy's allowlist is the whole security boundary. These are the
 * cases that would turn it into an open relay, pinned so they fail a test run
 * rather than a code review.
 */
describe("tile proxy allowlist", () => {
  it("allows the basemap CDNs and their shards", () => {
    for (const host of [
      "basemaps.cartocdn.com",
      "tiles.basemaps.cartocdn.com",
      "tiles-a.basemaps.cartocdn.com",
      "tiles-d.basemaps.cartocdn.com",
      "server.arcgisonline.com",
      "s3.amazonaws.com",
    ]) {
      expect(allowedHostForTest(host), host).toBe(true);
    }
  });

  it("refuses a lookalike that merely ends with the name", () => {
    // The leading dot on the suffix is what stops these.
    for (const host of [
      "evil-cartocdn.com",
      "cartocdn.com.attacker.test",
      "notarcgisonline.com",
      "evilarcgisonline.com",
    ]) {
      expect(allowedHostForTest(host), host).toBe(false);
    }
  });

  it("refuses an S3 lookalike rather than trusting the suffix", () => {
    // `s3.amazonaws.com` is an exact host for exactly this reason: matched as
    // a suffix it would accept anything ending in it, and `.amazonaws.com`
    // would open the proxy onto every AWS service endpoint there is.
    for (const host of [
      "evil-s3.amazonaws.com",
      "attacker.amazonaws.com",
      "ec2.amazonaws.com",
      "s3.amazonaws.com.attacker.test",
    ]) {
      expect(allowedHostForTest(host), host).toBe(false);
    }
  });

  it("refuses the addresses that make SSRF worth having a list for", () => {
    for (const host of [
      "169.254.169.254",
      "localhost",
      "127.0.0.1",
      "metadata.google.internal",
      "10.0.0.1",
      "[::1]",
    ]) {
      expect(allowedHostForTest(host), host).toBe(false);
    }
  });

  it("is case insensitive", () => {
    expect(allowedHostForTest("TILES-A.BASEMAPS.CARTOCDN.COM")).toBe(true);
    expect(allowedHostForTest("EVIL-CARTOCDN.COM")).toBe(false);
  });
});
