import type { InfraObservation, Subject } from "@scout/sources";
import { requireSource } from "@scout/sources";

export const uscgSource = requireSource("uscg-psix");

/**
 * USCG Port State Information eXchange.
 *
 * What this does NOT give is the owner. I expected it to and it does not: the
 * Coast Guard withdrew registered-owner details from public vessel
 * documentation years ago, so a hull here resolves to an identity and a safety
 * history, never to a person. Saying that plainly matters more than the rows —
 * an investigator who assumes otherwise reads an absent owner as an unowned
 * vessel.
 *
 * What it does give is real: official number, flag, service type, operating
 * status, and the inspection deficiencies recorded against the hull. For a
 * vessel that turns up somewhere it should not be, the deficiency history is
 * frequently the more useful half anyway.
 *
 * SOAP, and the namespace is https — the http form returns "Server did not
 * recognize the value of HTTP Header SOAPAction", which reads like a broken
 * request rather than a wrong scheme.
 */

const ENDPOINT = "https://cgmix.uscg.mil/xml/PSIXData.asmx";
const NS = "https://cgmix.uscg.mil";
const TIMEOUT_MS = 30_000;

/** XML entities, as the service double-encodes its payload. */
function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tag(block: string, name: string): string | null {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value === "" || value === "N/A" ? null : value;
}

/** Every <VesselSummary> element in the returned dataset. */
export function readSummaries(xml: string): InfraObservation[] {
  const inner = unescapeXml(xml);
  const blocks = inner.match(/<VesselSummary>[\s\S]*?<\/VesselSummary>/g) ?? [];

  return blocks.flatMap((block): InfraObservation[] => {
    const name = tag(block, "VesselName");
    if (name === null) return [];

    const identification = tag(block, "Identification");
    const idType = tag(block, "IdentificationTypeLookupName");
    const year = tag(block, "ConstructionCompletedYear");

    return [{
      kind: "registration",
      domain: name,
      // No owner is available, so the registrar slot carries the identity the
      // Coast Guard does publish rather than being left blank.
      registrar: [
        tag(block, "ServiceType"),
        tag(block, "CountryLookupName"),
      ]
        .filter((x): x is string => x !== null)
        .join(" · ") || "US Coast Guard record",
      created: null,
      updated: null,
      expires: null,
      nameservers: [],
      statuses: [
        ...(identification === null
          ? []
          : [`${idType ?? "ID"} ${identification}`]),
        ...(year === null || year === "0" ? [] : [`Built ${year}`]),
        ...(tag(block, "StatusLookupName") === null ? [] : [tag(block, "StatusLookupName") as string]),
        ...(tag(block, "VesselCallSign") === null ? [] : [`Call sign ${tag(block, "VesselCallSign") as string}`]),
        "Owner not published by USCG",
      ],
    }];
  });
}

export async function fetchUscg(subject: Subject): Promise<InfraObservation[]> {
  if (subject.kind !== "vessel") return [];
  const term = subject.value.trim();
  if (term === "") return [];

  // The service searches by name or call sign, not by MMSI — there is no MMSI
  // field in the schema. A numeric subject has nothing to match here.
  if (/^\d+$/.test(term.replace(/^IMO/i, ""))) return [];

  const envelope =
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<getVesselSummaryXMLString xmlns="${NS}">` +
    `<VesselID>0</VesselID>` +
    `<VesselName>${term.replace(/[<>&]/g, "")}</VesselName>` +
    `<CallSign></CallSign><VIN></VIN><HIN></HIN><Flag></Flag><Service></Service><BuildYear></BuildYear>` +
    `</getVesselSummaryXMLString></soap:Body></soap:Envelope>`;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "text/xml; charset=utf-8",
      soapaction: `"${NS}/getVesselSummaryXMLString"`,
    },
    body: envelope,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!response.ok) throw new Error(`USCG PSIX responded ${response.status}`);
  return readSummaries(await response.text()).slice(0, 40);
}
