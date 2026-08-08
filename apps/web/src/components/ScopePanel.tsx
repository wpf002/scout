"use client";

import { useState } from "react";
import { api, ApiError } from "@/lib/api";
import type { CaseRecord, ScopeEntry } from "@/lib/types";

/**
 * The scope editor.
 *
 * Adding scope is an authorization decision, not a settings tweak, so it goes
 * through an explicit confirmation that is recorded in the audit log. The UI
 * cannot skip it: the API refuses a scope addition that does not carry the
 * confirmation.
 */
export function ScopePanel({
  record,
  onChange,
}: {
  record: CaseRecord;
  onChange: (entries: ScopeEntry[]) => void;
}) {
  const [kind, setKind] = useState<"domain" | "identifier">("domain");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  async function add() {
    setPending(true);
    setError(null);
    try {
      const entry = await api.addScope(record.id, {
        kind,
        value: value.trim(),
        ...(note.trim().length > 0 ? { note: note.trim() } : {}),
      });
      onChange([...record.scopeEntries, entry]);
      setValue("");
      setNote("");
      setConfirming(false);
      setAcknowledged(false);
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to add scope.",
      );
    } finally {
      setPending(false);
    }
  }

  async function remove(entryId: string) {
    setError(null);
    try {
      await api.removeScope(record.id, entryId);
      onChange(record.scopeEntries.filter((e) => e.id !== entryId));
    } catch (caught) {
      setError(
        caught instanceof ApiError ? caught.message : "Failed to remove scope.",
      );
    }
  }

  return (
    <div className="card">
      <div className="spread" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Authorization scope</h2>
        {record.scopeEntries.length === 0 ? (
          <span className="badge deny">scoped tiers off</span>
        ) : (
          <span className="badge ok">
            {record.scopeEntries.length} entr
            {record.scopeEntries.length === 1 ? "y" : "ies"}
          </span>
        )}
      </div>

      {error !== null && <div className="error">{error}</div>}

      {record.scopeEntries.length === 0 ? (
        <div className="notice">
          No scope on this case, so every person-facing source is off. Empty
          scope means <strong>off</strong>, never unrestricted.
        </div>
      ) : (
        <div className="chip-list" style={{ marginBottom: 14 }}>
          {record.scopeEntries.map((entry) => (
            <span className="scope-chip" key={entry.id}>
              <span className="faint">
                {entry.kind === "DOMAIN" ? "domain" : "id"}
              </span>
              {entry.value}
              <button
                className="tiny danger"
                onClick={() => void remove(entry.id)}
                title="Remove from scope"
                aria-label={`Remove ${entry.value} from scope`}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="row" style={{ alignItems: "flex-end" }}>
        <div style={{ width: 130 }}>
          <label htmlFor="scope-kind">Kind</label>
          <select
            id="scope-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="domain">domain</option>
            <option value="identifier">identifier</option>
          </select>
        </div>
        <div style={{ flex: 1, minWidth: 170 }}>
          <label htmlFor="scope-value">
            {kind === "domain" ? "Domain (and subdomains)" : "Exact identifier"}
          </label>
          <input
            id="scope-value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              kind === "domain" ? "acme.example" : "alice@acme.example"
            }
          />
        </div>
        <div style={{ flex: 1, minWidth: 150 }}>
          <label htmlFor="scope-note">Note</label>
          <input
            id="scope-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="optional"
          />
        </div>
        <button
          onClick={() => setConfirming(true)}
          disabled={value.trim().length === 0}
        >
          Add to scope
        </button>
      </div>

      {confirming && (
        <div className="backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Confirm you are authorized</h2>
            <p className="dim" style={{ fontSize: 13 }}>
              Adding scope widens what Scout is permitted to do against real
              people and real infrastructure. This claim is written to the
              case&rsquo;s audit log under your operator name.
            </p>

            <div className="confirm-table">
              <div>
                <dt>Adding</dt>
                <dd className="mono">
                  {kind}: {value.trim()}
                </dd>
              </div>
              <div>
                <dt>To case</dt>
                <dd>{record.name}</dd>
              </div>
              <div>
                <dt>Authorization</dt>
                <dd className="mono">{record.authorizationRef}</dd>
              </div>
            </div>

            <label
              className="row"
              style={{ alignItems: "flex-start", cursor: "pointer" }}
            >
              <input
                type="checkbox"
                style={{ width: "auto", marginTop: 3 }}
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span style={{ flex: 1, color: "var(--text)" }}>
                I am authorized to investigate this target under the
                authorization reference above.
              </span>
            </label>

            <div className="row" style={{ marginTop: 18 }}>
              <button
                className="primary"
                disabled={!acknowledged || pending}
                onClick={() => void add()}
              >
                {pending ? "Adding…" : "Add to scope"}
              </button>
              <button
                onClick={() => {
                  setConfirming(false);
                  setAcknowledged(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
