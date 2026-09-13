import { describe, expect, it } from "vitest";

import { titleCase } from "./label";

describe("titleCase", () => {
  it("capitalises a plain key", () => {
    expect(titleCase("domain")).toBe("Domain");
    expect(titleCase("username")).toBe("Username");
    expect(titleCase("keyword")).toBe("Keyword");
  });

  it("spells the ones that are spelled, not capitalised", () => {
    // "Ip" is the failure this table exists to prevent: it looks like someone
    // tried and got it wrong, which is worse than leaving it alone.
    expect(titleCase("ip")).toBe("IP");
    expect(titleCase("asn")).toBe("ASN");
    expect(titleCase("url")).toBe("URL");
    expect(titleCase("ipv6")).toBe("IPv6");
  });

  it("fixes a sentence that was only capitalised at the front", () => {
    expect(titleCase("Geofence check")).toBe("Geofence Check");
    expect(titleCase("Detect automatically")).toBe("Detect Automatically");
  });

  it("splits keys on underscores and keeps hyphens", () => {
    expect(titleCase("sat_comms")).toBe("Sat Comms");
    expect(titleCase("day_night")).toBe("Day Night");
    expect(titleCase("cross-domain")).toBe("Cross-Domain");
  });

  it("leaves minor words lowercase, except at the start", () => {
    expect(titleCase("ports of call")).toBe("Ports of Call");
    expect(titleCase("of counsel")).toBe("Of Counsel");
    expect(titleCase("the hague")).toBe("The Hague");
  });

  it("does not damage a word that already has its own capitals", () => {
    // Every rule that "fixes" these makes them wrong.
    expect(titleCase("iPhone backup")).toBe("iPhone Backup");
    expect(titleCase("eBay seller")).toBe("eBay Seller");
    expect(titleCase("McDonald route")).toBe("McDonald Route");
  });

  it("re-cases a shouted word", () => {
    expect(titleCase("URGENT case")).toBe("Urgent Case");
  });

  it("survives the empty and the odd", () => {
    expect(titleCase("")).toBe("");
    expect(titleCase("   ")).toBe("");
    expect(titleCase("a")).toBe("A");
  });

  it("leaves an already-correct label untouched", () => {
    // Idempotence matters: these labels are re-rendered constantly, and a
    // function that drifted on each pass would be very hard to spot.
    for (const label of ["Domain", "IP", "Ports of Call", "Cross-Domain"]) {
      expect(titleCase(label)).toBe(label);
      expect(titleCase(titleCase(label))).toBe(label);
    }
  });
});
