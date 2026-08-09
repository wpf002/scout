"use client";

import { useEffect, useState } from "react";

/**
 * A loading state that gives up on itself.
 *
 * "Loading…" that never resolves is the worst thing an interface can show: it
 * looks like progress, so nobody investigates, and it is indistinguishable from
 * a server that accepted the connection and then went silent. After a few
 * seconds this stops claiming to be loading and says what is probably wrong and
 * what to do about it.
 *
 * The API client has a hard request timeout for the same reason — this is the
 * second half of that, for the window before it fires and for the case where
 * something never issued the request at all.
 */
export function Loading({
  what = "this",
  after = 6000,
}: {
  /** Named in the diagnosis: "Still waiting on the alert feed." */
  what?: string;
  after?: number;
}) {
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), after);
    return () => clearTimeout(timer);
  }, [after]);

  if (!slow) return <div className="empty">Loading…</div>;

  return (
    <div className="notice" style={{ marginTop: 8 }}>
      <strong>Still waiting on {what}.</strong>
      <div style={{ marginTop: 6 }}>
        The dashboard is running — it is the API behind it that has not
        answered. Two things account for almost every case:
      </div>
      <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        <li>
          The API is not up. <code>pnpm start</code> runs both and will not
          report success until each one answers.
        </li>
        <li>
          You are looking at a different server. The dashboard is on{" "}
          <code>:3000</code> — a page on another port, or on port 80, is not
          this app.
        </li>
      </ul>
      <div className="faint" style={{ marginTop: 7, fontSize: 11.5 }}>
        Reload once the API is up. Nothing here retries on its own, because a
        silent retry loop is how a broken connection looks healthy.
      </div>
    </div>
  );
}
