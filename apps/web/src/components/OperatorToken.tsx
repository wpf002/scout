"use client";

import { useEffect, useState } from "react";
import { getOperatorToken, setOperatorToken } from "@/lib/api";

/**
 * Operator token entry.
 *
 * Only needed when the API runs with `SCOUT_AUTH_REQUIRED=true`. The token
 * lives in sessionStorage — never in the build, never in a NEXT_PUBLIC_ var —
 * so it does not ship to every visitor and does not end up committed.
 */
export function OperatorToken() {
  const [token, setToken] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => setToken(getOperatorToken()), []);

  function save() {
    setOperatorToken(draft);
    setToken(getOperatorToken());
    setDraft("");
    setEditing(false);
    // The whole page is data fetched under the old identity.
    window.location.reload();
  }

  if (editing) {
    return (
      <span className="row" style={{ gap: 6 }}>
        <input
          aria-label="Operator token"
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="scout_…"
          style={{ width: 190, fontSize: 12, padding: "4px 8px" }}
        />
        <button className="tiny primary" onClick={save}>
          Save
        </button>
        <button className="tiny" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      className="tiny"
      onClick={() => setEditing(true)}
      title={
        token === null
          ? "No operator token set. Required when the API has auth enabled."
          : "An operator token is set for this session."
      }
    >
      {token === null ? "Set token" : "Token set ●"}
    </button>
  );
}
