import { describe, expect, it } from "vitest";
import { normalizeOpenSanctions } from "./opensanctions.js";
import { normalizeIntelx } from "./intelx.js";

describe("OpenSanctions", () => {
  const payload = {
    results: [
      {
        id: "NK-abc",
        caption: "Jane Designated",
        schema: "Person",
        datasets: ["us_ofac_sdn", "eu_fsf"],
        score: 0.94,
        properties: {
          country: ["ru"],
          topics: ["sanction"],
          email: ["Jane@Example.Org"],
          website: [],
          name: ["Jane Designated"],
        },
      },
      {
        id: "NK-def",
        caption: "Politically Exposed",
        schema: "Person",
        datasets: ["everypolitician"],
        score: 0.7,
        properties: {
          country: ["gb"],
          topics: ["role.pep"],
          email: [],
          website: ["https://example.org/profile"],
          name: [],
        },
      },
    ],
  };

  const matches = normalizeOpenSanctions(payload);

  it("carries the source datasets through as provenance", () => {
    // Which list an entity is on IS the finding, not metadata about it.
    expect(matches[0]?.datasets).toEqual(["eu_fsf", "us_ofac_sdn"]);
  });

  it("marks an actually-designated entity as sanctioned", () => {
    expect(matches[0]?.sanctioned).toBe(true);
  });

  it("does NOT mark a PEP listing as sanctioned", () => {
    // A PEP listing says someone holds public office. Rendering it as
    // "SANCTIONED" would be a false accusation against every politician in
    // the dataset.
    expect(matches[1]?.sanctioned).toBe(false);
    expect(matches[1]?.designation).toBe("pep");
    expect(matches[1]?.topics).toEqual(["role.pep"]);
  });

  it("does NOT mark an associate of a sanctioned entity as sanctioned", () => {
    // The failure this guards against is subtle and severe: `sanction.linked`
    // reads like a sanction topic, and treating it as one would designate
    // someone who has not been designated.
    const linked = normalizeOpenSanctions({
      results: [
        {
          id: "NK-ghi",
          caption: "Associated Holdings Ltd",
          schema: "Company",
          datasets: ["us_ofac_sdn"],
          score: 0.6,
          properties: {
            country: [],
            topics: ["sanction.linked"],
            email: [],
            website: [],
            name: [],
          },
        },
      ],
    });

    expect(linked[0]?.sanctioned).toBe(false);
    expect(linked[0]?.designation).toBe("linked-to-sanctioned");
  });

  it("carries the designation alongside the boolean", () => {
    expect(matches[0]?.designation).toBe("sanctioned");
  });

  it("extracts structured entities at high confidence", () => {
    const entities = matches[0]?.entities ?? [];
    const email = entities.find((e) => e.kind === "email");
    expect(email?.value).toBe("jane@example.org");
    expect(email?.confidence).toBe("high");

    const person = entities.find((e) => e.kind === "person");
    expect(person?.value).toBe("Jane Designated");
  });

  it("reduces a website property to a bare hostname", () => {
    const domain = matches[1]?.entities.find((e) => e.kind === "domain");
    expect(domain?.value).toBe("example.org");
  });

  it("handles an empty result set", () => {
    expect(normalizeOpenSanctions({ results: [] })).toEqual([]);
  });
});

describe("Intelligence X", () => {
  const payload = {
    status: 0,
    records: [
      {
        systemid: "abc-123",
        name: "combolist_2026.txt",
        description: "contact: ops@acme.example — mirror at files.acme.example",
        date: "2026-01-02T00:00:00",
        bucket: "leaks.public",
        media: 1,
        typeh: "text",
      },
    ],
  };

  const hits = normalizeIntelx(payload, "acme.example");

  it("keeps the bucket as the dataset id", () => {
    // A hit in leaks.public means something very different from one in pastes.
    expect(hits[0]?.datasetId).toBe("leaks.public");
  });

  it("records the term that matched", () => {
    expect(hits[0]?.matchedTerm).toBe("acme.example");
  });

  it("links to the provider's viewer for the investigator to open", () => {
    expect(hits[0]?.url).toBe("https://intelx.io/?did=abc-123");
  });

  it("extracts entities from free text at medium confidence", () => {
    const entities = hits[0]?.entities ?? [];
    const email = entities.find((e) => e.value === "ops@acme.example");
    expect(email?.kind).toBe("email");
    expect(email?.confidence).toBe("medium");

    const domain = entities.find((e) => e.value === "files.acme.example");
    expect(domain?.kind).toBe("domain");
  });

  it("does not emit an email's own domain as a separate suggestion", () => {
    const values = (hits[0]?.entities ?? []).map((e) => e.value);
    // acme.example appears only inside ops@acme.example, so suggesting it
    // again as a bare domain would be noise.
    expect(values.filter((v) => v === "acme.example")).toHaveLength(0);
  });

  it("handles a record with no description", () => {
    const bare = normalizeIntelx(
      {
        status: 0,
        records: [
          {
            systemid: "x",
            name: "",
            description: null,
            date: null,
            bucket: "",
            media: null,
            typeh: null,
          },
        ],
      },
      "term",
    );
    expect(bare[0]?.datasetId).toBe("intelx");
    expect(bare[0]?.title).toBe("x");
    expect(bare[0]?.entities).toEqual([]);
  });
});
