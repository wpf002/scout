"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import type {
  AttributedObservation,
  CaseRecord,
  InfraObservation,
  InfraSweepResult,
  PivotRequest,
} from "@/lib/types";

/**
 * The infrastructure board.
 *
 * One board rather than four source-shaped panels: Shodan, Censys,
 * SecurityTrails and crt.sh all normalize into the same three shapes, so a
 * hostname seen by three sources is one row that credits all three.
 *
 * Sweeping several sources at once is allowed here — and only here — because
 * these sources look at hosts and certificates, not at people. The API draws
 * the sweep from its infra adapter registry, so no person-facing source can
 * reach this path.
 */
export function InfraBoard({
  record,
  onFindingSaved,
  pivot,
}: {
  record: CaseRecord;
  onFindingSaved: () => void;
  /** A subject carried in from the graph. Fills the form; sweeps nothing. */
  pivot?: PivotRequest | null;
}) {
  const [value, setValue] = useState("");
  const [result, setResult] = useState<InfraSweepResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | InfraObservation["kind"]>("all");
  const [saved, setSaved] = useState<Set<string>>(new Set());

  // Only domain and IP pivots land here — the board sweeps infrastructure, and
  // a person's name in this box would just fail four ways at once.
  useEffect(() => {
    if (pivot === undefined || pivot === null) return;
    if (pivot.kind !== "domain" && pivot.kind !== "ip") return;
    setValue(pivot.value);
    setResult(null);
  }, [pivot]);

  async function sweep(event: React.FormEvent) {
    event.preventDefault();
    setRunning(true);
    setError(null);
    try {
      setResult(
        await api.infraSweep({
          caseId: record.id,
          subject: { kind: "domain", value: value.trim() },
        }),
      );
      setSaved(new Set());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Sweep failed.");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }

  async function save(item: AttributedObservation, key: string) {
    if (result === null) return;
    const primary = item.sourceIds[0];
    if (primary === undefined) return;

    const log = result.sources.find((s) => s.sourceId === primary)?.queryLogId;

    try {
      await api.saveFinding(record.id, {
        // Provenance names one source as the origin and keeps the full
        // attribution in the payload, so a merged row never loses who saw it.
        sourceId: primary,
        title: describe(item.observation),
        summary: `Reported by ${item.sourceIds.join(", ")}.`,
        data: { ...item.observation, sourceIds: item.sourceIds },
        queryTerm: result.subject.value,
        queryKind: "domain",
        ...(log === null || log === undefined ? {} : { queryLogId: log }),
      });
      setSaved((current) => new Set(current).add(key));
      onFindingSaved();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to save finding.",
      );
    }
  }

  const shown =
    result === null
      ? []
      : result.observations.filter(
          (item) => filter === "all" || item.observation.kind === filter,
        );

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Infrastructure board</h2>
        <span className="badge">non-scoped tier</span>
      </div>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 0 }}>
        Sweeps every infrastructure source that accepts a domain and merges the
        results. No scope gate — these look at hosts and certificates, not
        people.
      </p>

      <form onSubmit={sweep}>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <div style={{ flex: 1, minWidth: 200 }}>
            <label htmlFor="sweep-domain">Domain</label>
            <input
              id="sweep-domain"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="acme.example"
              required
            />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={running || value.trim().length === 0}
          >
            {running ? "Sweeping…" : "Sweep infrastructure"}
          </button>
        </div>
      </form>

      {error !== null && (
        <div className="error" style={{ marginTop: 14 }}>
          {error}
        </div>
      )}

      {result !== null && (
        <>
          <div className="row" style={{ marginTop: 16, marginBottom: 10 }}>
            {result.sources.map((source) => (
              <span
                key={source.sourceId}
                className={`badge ${
                  source.status === "ok"
                    ? "ok"
                    : source.status === "inert"
                      ? "warn"
                      : "deny"
                }`}
                title={source.message ?? undefined}
              >
                {source.sourceId}
                {source.status === "ok"
                  ? ` ${source.observationCount}`
                  : ` ${source.reason ?? source.status}`}
              </span>
            ))}
          </div>

          <div className="notice">
            {result.totals.rawObservations} raw observations merged into{" "}
            <strong>{result.totals.merged}</strong> — {result.totals.subdomain}{" "}
            subdomains, {result.totals.host} hosts, {result.totals.cert}{" "}
            certificates.
          </div>

          {result.excluded.length > 0 && (
            // Never let a source's absence read as "no result". An excluded
            // source was not asked, which is a different thing from finding
            // nothing.
            <div className="notice">
              <strong>Not swept:</strong>{" "}
              {result.excluded.map((e) => (
                <span key={e.sourceId} style={{ marginRight: 10 }}>
                  <span className="mono">{e.sourceId}</span> ({e.reason})
                </span>
              ))}
            </div>
          )}

          <div className="row" style={{ marginBottom: 10 }}>
            {(["all", "subdomain", "host", "cert"] as const).map((option) => (
              <button
                key={option}
                className="tiny"
                onClick={() => setFilter(option)}
                style={
                  filter === option
                    ? { borderColor: "var(--accent)", color: "var(--accent)" }
                    : undefined
                }
              >
                {option}
              </button>
            ))}
          </div>

          {shown.length === 0 ? (
            <div className="empty">
              Nothing returned. Sources with no key report inert rather than
              guessing.
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Observation</th>
                  <th>Seen by</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((item) => {
                  const key = `${item.observation.kind}:${describe(item.observation)}`;
                  return (
                    <tr key={key}>
                      <td>
                        <span className="badge" style={{ marginRight: 8 }}>
                          {item.observation.kind}
                        </span>
                        <span className="mono">
                          {describe(item.observation)}
                        </span>
                        {detail(item.observation) !== null && (
                          <div className="faint" style={{ fontSize: 11 }}>
                            {detail(item.observation)}
                          </div>
                        )}
                      </td>
                      <td className="faint mono" style={{ fontSize: 11 }}>
                        {item.sourceIds.join(", ")}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <button
                          className="tiny"
                          disabled={saved.has(key)}
                          onClick={() => void save(item, key)}
                        >
                          {saved.has(key) ? "Saved" : "+ Save"}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  );
}

function describe(observation: InfraObservation): string {
  switch (observation.kind) {
    case "subdomain":
      return observation.hostname;
    case "host":
      return observation.ip;
    case "cert":
      return observation.commonName;
  }
}

function detail(observation: InfraObservation): string | null {
  switch (observation.kind) {
    case "subdomain":
      return observation.lastSeen === null
        ? null
        : `last seen ${observation.lastSeen}`;
    case "host": {
      const bits = [
        observation.ports.length > 0
          ? `ports ${observation.ports.join(", ")}`
          : null,
        observation.org,
        observation.asn,
        observation.country,
      ].filter((bit): bit is string => bit !== null && bit.length > 0);
      return bits.length > 0 ? bits.join(" · ") : null;
    }
    case "cert": {
      const names =
        observation.names.length > 1
          ? `${observation.names.length} names`
          : null;
      const bits = [observation.issuer, names, observation.notAfter].filter(
        (bit): bit is string => bit !== null && bit.length > 0,
      );
      return bits.length > 0 ? bits.join(" · ") : null;
    }
  }
}
