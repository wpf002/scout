"use client";

import { useEffect } from "react";

/**
 * What the operator sees when a render throws.
 *
 * Without this file Next renders nothing — a white screen with the failure
 * only in the browser console, which is the one place someone watching a map
 * is not looking. A map that has stopped must say so.
 *
 * Deliberately not a full-page takeover of the console's styling: it reuses
 * the app's own tokens so it reads as Scout reporting a fault rather than the
 * browser reporting one.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The message is on screen either way; this keeps the stack somewhere a
    // developer can find it after the fact.
    console.error("Scout stopped:", error);
  }, [error]);

  return (
    <div className="fault">
      <h1>Scout stopped</h1>
      <p>
        Something in the interface threw and the map is no longer updating.
        Nothing was lost — cases, findings and monitors are on the server, not
        in this page.
      </p>
      <p className="fault-message">{error.message}</p>
      {error.digest === undefined ? null : (
        <p className="fault-digest">Reference {error.digest}</p>
      )}
      <div className="fault-actions">
        <button onClick={reset}>Try Again</button>
        <button onClick={() => window.location.reload()}>Reload</button>
      </div>
    </div>
  );
}
