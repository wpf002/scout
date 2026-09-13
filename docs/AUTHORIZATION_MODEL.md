# Authorization in v2

## What an authorization is

v1 authorizes a case with a reference string and a list of scope entries. v2
adds an `Authorization` row that a case can point at:

| Field | Meaning |
|---|---|
| `reference` | The engagement reference. Same string as `Case.authorizationRef`. |
| `issuedBy` | Who granted it: a court, a client, a statute, a contract. |
| `boundary.scope` | v1 scope entries, matched by the same `checkScope()`. |
| `boundary.entityKinds` | Which entity kinds may be resolved or read. Empty means any. |
| `sourceClasses` | Which source classes may be collected from. |
| `actionClasses` | COLLECT, RESOLVE, READ_GRAPH, BIOMETRIC_COMPARE, PROPOSE, APPROVE_CONSEQUENTIAL. |
| `validFrom`, `validUntil` | The window. |
| `revokedAt`, `revokedBy`, `revokedReason` | Revocation. Nothing runs under it afterwards. |

## The scope context

`ScopeContext.build()` in `packages/scope/src/context.ts` is the only way to get
a context. It parses the row, refuses a revoked, expired or not-yet-started
authorization with a stable deny reason, and carries the operator. Every v2
function that touches data takes a `ScopeContext` as a required parameter.
There is no default, no optional form, and no way to construct one from
nothing.

Long runs call `assertLive()` before each write, so an authorization revoked
mid-run stops the run at the next write.

## Enforcement points

| Act | Check | Where |
|---|---|---|
| Register a collector | Licensing terms present | `defineCollector()` |
| Collect | `COLLECT` + collector's source class + live window | `assertMayCollect()` |
| Write an observation | Four provenance fields present | `assertProvenance()`, then NOT NULL columns |
| Resolve | `RESOLVE` + entity kind in boundary | resolution route, Phase 6 |
| Read entities or edges | `READ_GRAPH` + entity kind in boundary + `asOf` predicate | graph read path, Phase 5 |
| Compare biometrics | Named gallery + lawful basis + `BIOMETRIC_COMPARE` | `refuseOpenWorldBiometric()` |
| Execute consequential action | Recorded, unused, unexpired approval for this proposal | `refuseAutonomousConsequential()` |

Every read writes an `AccessLog` row: actor, authorization, action, target
type, target ids, query text if any, result count, time. Ids, never payloads.
The table has the same UPDATE/DELETE-rejecting trigger as `QueryLog`.

## What v1 keeps

The v1 gate is unchanged. `SCOUT_AUTHORIZE_ALL` still applies to the case tiers
and only to them; v2 code does not read it. A case with no `authorizationId`
works exactly as before for everything it could already do, and cannot
collect, resolve or read the v2 graph until it gets one.

## Deny reasons added

`authorization-revoked`, `authorization-expired`,
`authorization-not-started`, `action-not-permitted`,
`source-class-not-permitted`. Appended to `DENY_REASONS`; existing values are
untouched.
