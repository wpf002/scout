# Legal posture

Written for a customer's counsel. Each section names the law, what it
prohibits, what Scout does instead, and where in the code the refusal lives.
The refusals are enforced by named guards in `packages/scope/src/prohibitions.ts`
and each has a test that attempts the prohibited act and asserts refusal.

## 1. Unauthorized access to systems

**Law.** Computer Fraud and Abuse Act, 18 U.S.C. § 1030, and state analogues.
Accessing a computer without authorization or exceeding authorized access.

**Scout does not.** No credential testing, no exploitation, no session
hijacking, no reaching cameras, microphones or endpoints that were not
enrolled by their owner. Scout's only path to a device or system is the
first-party ingest API, which requires an enrollment with a consent record.

**Where.** `refuseUnauthorizedAccess()`. Existing v1 sources are all public
APIs, published records, or the investigator's own browser opening a link.

## 2. Interception of communications

**Law.** Wiretap Act, 18 U.S.C. § 2511; Stored Communications Act, 18 U.S.C.
§ 2701 (together, ECPA). Intercepting wire, oral or electronic communications
in transit, or accessing stored communications without authorization.

**Scout does not.** No packet capture of anyone's traffic, no telecom or SS7
interception, no reading of messages Scout is not a party to or explicitly
authorized to receive. The first two are refused under every authorization.

**Where.** `refuseInterception()`.

## 3. Biometric identification

**Law.** Illinois Biometric Information Privacy Act, 740 ILCS 14 (written
consent before collection; private right of action). Texas Capture or Use of
Biometric Identifier Act, Bus. & Com. Code § 503.001. GDPR Article 9
(biometric data for unique identification is special-category data;
processing prohibited absent a listed basis).

**The worked example.** Clearview AI built a face index from scraped public
images. It settled ACLU's BIPA action in 2022 with a permanent ban on selling
the database to most private entities, and drew fines from the French CNIL,
the UK ICO, the Italian Garante and the Dutch Autoriteit Persoonsgegevens.
That is the product Scout is built to be unable to become.

**Scout does not.** Face and voice comparison runs only 1:N against a named,
enrolled gallery. Each gallery records a lawful basis (consent, court order,
statutory authority, employment, contract) and a document reference; each
enrollment records its own, expires, and requires re-review. Templates are
stored encrypted and apart from media. There is no route that accepts a probe
without a gallery id, and enrollment from scraped or open-web media is refused.
Every comparison is logged whether or not it matched. The service is off by
default.

**How, as built.** A gallery is created only with `confirmLawfulBasis: true`,
a document reference and a future review date; a comparison against a
gallery whose review date has passed is refused (HTTP 409) until the
custodian records a new one. An enrollment states its media's origin;
`public-scrape` and `open-web` are refused by `refuseBiometricIndexing()`
before the gallery is looked up, and the refusal is an audit event. The
media is turned into a vector by the service and discarded; only its hash
is kept, in the enrollment's audit event. The vector is sealed with
AES-256-GCM under `RECOGNITION_TEMPLATE_KEY` (`BiometricTemplate`); without
the key, enrollment is refused rather than stored in the clear. A
comparison decrypts only the unrevoked, unexpired templates of one modality
in one gallery for that call, and its outcome is written to the immutable
`BiometricComparison` table (probe hash, gallery, authorization, requester,
top candidates, threshold, decision) before the answer returns. A close call
between two candidates is `INDETERMINATE`, never a confident identity.

**Where.** `refuseOpenWorldBiometric()`, `refuseBiometricIndexing()`
(`packages/scope`), `apps/api/src/v2/recognition.ts` (custodian, gates,
audit, encryption), `services/recognition` (`RECOGNITION_ENABLED=false`;
both `EmbedRequest.gallery_id` and `CompareRequest.gallery_id` required;
models installed only by `uv sync --extra models`).

## 4. Autonomous consequential action

**Law.** Not a single statute. Liability attaches to the act: an unauthorized
collection is a CFAA question, a wrongful disclosure a privacy question. Scout
removes the possibility of a machine taking such an act on its own.

**Scout does not.** The agent observes and prepares. Anything with an external
effect requires a recorded human approval tied to that one proposal, unused,
and unexpired. `AGENT_MAX_AUTONOMOUS_TIER` cannot be set to `consequential`;
the process refuses to start.

**Where.** `refuseAutonomousConsequential()`, `assertMaxAutonomousTier()`.

## 5. Forced resolution

**Law.** Defamation and false-light exposure when two people are merged into
one record; FCRA-style accuracy duties where records affect a person.

**Scout does not.** Resolution returns UNRESOLVED and INDETERMINATE as
first-class answers. The review band between the thresholds cannot be
configured away, and a cluster whose pairwise evidence disagrees is marked
DISPUTED rather than merged.

**Where.** `refuseForcedResolution()`, `classifyScore()`,
`assertClusterConsistent()`.

## Provenance and audit

Every observation carries source, authorization, collection time and
observation time as NOT NULL columns. Every read of the v2 graph writes an
`AccessLog` row. `QueryLog`, `AuditEvent`, `AccessLog`, `MatchDecision` and
`BiometricComparison` reject UPDATE and DELETE at the database.

## Coverage

Scout does not claim to see everything. `docs/COVERAGE_LIMITS.md` is shown to
users during onboarding and says what lawfully sourced data cannot show.
