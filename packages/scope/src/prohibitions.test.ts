import { describe, expect, it } from "vitest";

import { ScopeContext } from "./context.js";
import {
  PROHIBITIONS,
  ProhibitionError,
  assertClusterConsistent,
  assertMaxAutonomousTier,
  classifyScore,
  refuseAutonomousConsequential,
  refuseBiometricIndexing,
  refuseForcedResolution,
  refuseInterception,
  refuseOpenWorldBiometric,
  refuseUnauthorizedAccess,
} from "./prohibitions.js";

const NOW = new Date("2026-09-13T12:00:00Z");

function context(actionClasses: string[]) {
  return ScopeContext.build({
    operator: "alice",
    now: NOW,
    authorization: {
      id: "auth_1",
      reference: "ENG-1",
      issuedBy: "court order 2026-CV-1",
      boundary: { scope: [{ kind: "domain", value: "example.com" }], entityKinds: [] },
      sourceClasses: ["FIRST_PARTY"],
      actionClasses,
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      revokedAt: null,
    },
  });
}

describe("the five prohibitions", () => {
  it("are named, each with a statute or policy reference", () => {
    expect(PROHIBITIONS.map((p) => p.id)).toEqual([
      "UNAUTHORIZED_ACCESS",
      "INTERCEPTION",
      "OPEN_WORLD_BIOMETRICS",
      "AUTONOMOUS_CONSEQUENTIAL_ACTION",
      "FORCED_RESOLUTION",
    ]);
    for (const p of PROHIBITIONS) expect(p.statute.length).toBeGreaterThan(10);
  });
});

describe("1. unauthorized access", () => {
  it("refuses a device that is not enrolled", () => {
    expect(() =>
      refuseUnauthorizedAccess({ kind: "device", enrolled: false, consentRef: null }),
    ).toThrow(ProhibitionError);
  });
  it("refuses an enrolled camera with no consent record", () => {
    expect(() =>
      refuseUnauthorizedAccess({ kind: "camera", enrolled: true, consentRef: "" }),
    ).toThrow(/consent/);
  });
  it("permits an enrolled, consented endpoint", () => {
    expect(() =>
      refuseUnauthorizedAccess({ kind: "endpoint", enrolled: true, consentRef: "fleet-consent-7" }),
    ).not.toThrow();
  });
});

describe("2. interception", () => {
  it("refuses packet capture and telecom intercept under any authorization", () => {
    for (const kind of ["packet-capture", "telecom-intercept"] as const) {
      expect(() =>
        refuseInterception({ kind, scoutIsParty: true, explicitAuthorizationRef: "X" }),
      ).toThrow(/in transit/);
    }
  });
  it("refuses reading a message Scout is not party to", () => {
    expect(() =>
      refuseInterception({ kind: "message-read", scoutIsParty: false, explicitAuthorizationRef: null }),
    ).toThrow(ProhibitionError);
  });
  it("permits reading a message Scout is a party to, or is explicitly authorized for", () => {
    expect(() =>
      refuseInterception({ kind: "message-read", scoutIsParty: true, explicitAuthorizationRef: null }),
    ).not.toThrow();
    expect(() =>
      refuseInterception({ kind: "message-read", scoutIsParty: false, explicitAuthorizationRef: "subpoena-9" }),
    ).not.toThrow();
  });
});

describe("3. open-world biometrics", () => {
  const permitted = context(["BIOMETRIC_COMPARE"]);
  const notPermitted = context(["COLLECT"]);

  it("refuses a comparison with no gallery", () => {
    expect(() =>
      refuseOpenWorldBiometric({ galleryId: null, galleryLawfulBasisRef: "doc", context: permitted }),
    ).toThrow(/no open-world/);
  });
  it("refuses a gallery with no lawful basis", () => {
    expect(() =>
      refuseOpenWorldBiometric({ galleryId: "g1", galleryLawfulBasisRef: null, context: permitted }),
    ).toThrow(/lawful basis/);
  });
  it("refuses when the scope does not permit BIOMETRIC_COMPARE", () => {
    expect(() =>
      refuseOpenWorldBiometric({ galleryId: "g1", galleryLawfulBasisRef: "doc", context: notPermitted }),
    ).toThrow(/does not permit BIOMETRIC_COMPARE/);
  });
  it("permits all three together", () => {
    expect(() =>
      refuseOpenWorldBiometric({ galleryId: "g1", galleryLawfulBasisRef: "doc", context: permitted }),
    ).not.toThrow();
  });
  it("refuses building templates from scraped or open-web media", () => {
    expect(() =>
      refuseBiometricIndexing({ origin: "public-scrape", lawfulBasisDocumentRef: "doc" }),
    ).toThrow(/scraped/);
    expect(() =>
      refuseBiometricIndexing({ origin: "open-web", lawfulBasisDocumentRef: "doc" }),
    ).toThrow(ProhibitionError);
    expect(() =>
      refuseBiometricIndexing({ origin: "consented-upload", lawfulBasisDocumentRef: null }),
    ).toThrow(/document/);
    expect(() =>
      refuseBiometricIndexing({ origin: "consented-upload", lawfulBasisDocumentRef: "consent-3" }),
    ).not.toThrow();
  });
});

describe("4. autonomous consequential action", () => {
  const approval = {
    proposalId: "p1",
    approvedBy: "alice",
    approvedAt: NOW,
    expiresAt: new Date("2026-09-13T13:00:00Z"),
    usedAt: null,
  };

  it("lets observe and prepare run without approval", () => {
    for (const tier of ["observe", "prepare"] as const) {
      expect(() =>
        refuseAutonomousConsequential({ proposalId: "p1", tier, approval: null }, NOW),
      ).not.toThrow();
    }
  });
  it("refuses consequential with no approval", () => {
    expect(() =>
      refuseAutonomousConsequential({ proposalId: "p1", tier: "consequential", approval: null }, NOW),
    ).toThrow(/no recorded human approval/);
  });
  it("refuses an approval for a different proposal", () => {
    expect(() =>
      refuseAutonomousConsequential(
        { proposalId: "p2", tier: "consequential", approval },
        NOW,
      ),
    ).toThrow(/not transferable/);
  });
  it("refuses a used approval", () => {
    expect(() =>
      refuseAutonomousConsequential(
        { proposalId: "p1", tier: "consequential", approval: { ...approval, usedAt: NOW } },
        NOW,
      ),
    ).toThrow(/single-use/);
  });
  it("refuses an expired approval", () => {
    expect(() =>
      refuseAutonomousConsequential(
        { proposalId: "p1", tier: "consequential", approval },
        new Date("2026-09-13T14:00:00Z"),
      ),
    ).toThrow(/expired/);
  });
  it("permits a live, unused, matching approval", () => {
    expect(() =>
      refuseAutonomousConsequential({ proposalId: "p1", tier: "consequential", approval }, NOW),
    ).not.toThrow();
  });
  it("refuses to boot with the maximum tier set to consequential", () => {
    expect(assertMaxAutonomousTier(undefined)).toBe("observe");
    expect(assertMaxAutonomousTier("prepare")).toBe("prepare");
    expect(() => assertMaxAutonomousTier("consequential")).toThrow(/Refused to start/);
    expect(() => assertMaxAutonomousTier("anything")).toThrow(ProhibitionError);
  });
});

describe("5. forced resolution", () => {
  it("refuses a collapsed or crossed review band", () => {
    expect(() => refuseForcedResolution({ matchThresholdBp: 8000, reviewThresholdBp: 8000 })).toThrow(/collapsed/);
    expect(() => refuseForcedResolution({ matchThresholdBp: 7000, reviewThresholdBp: 9000 })).toThrow(ProhibitionError);
    expect(() => refuseForcedResolution({ matchThresholdBp: 10001, reviewThresholdBp: 5 })).toThrow(/basis points/);
    expect(() => refuseForcedResolution({ matchThresholdBp: 9500, reviewThresholdBp: 7000 })).not.toThrow();
  });

  it("keeps the review band and returns INDETERMINATE for a score with no basis", () => {
    const t = { matchThresholdBp: 9500, reviewThresholdBp: 7000 };
    expect(classifyScore(9900, t)).toBe("MATCH");
    expect(classifyScore(9500, t)).toBe("MATCH");
    expect(classifyScore(8000, t)).toBe("REVIEW");
    expect(classifyScore(6999, t)).toBe("NON_MATCH");
    expect(classifyScore(null, t)).toBe("INDETERMINATE");
    expect(classifyScore(Number.NaN, t)).toBe("INDETERMINATE");
  });

  it("marks a cluster DISPUTED when transitivity fails, instead of merging", () => {
    const edges = [
      { left: "A", right: "B", outcome: "MATCH" as const },
      { left: "B", right: "C", outcome: "MATCH" as const },
      { left: "A", right: "C", outcome: "NON_MATCH" as const },
    ];
    expect(assertClusterConsistent(["A", "B", "C"], edges)).toBe("DISPUTED");
    expect(assertClusterConsistent(["A", "B", "C"], edges.slice(0, 2))).toBe("RESOLVED");
  });
});
