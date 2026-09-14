"use client";

import { useState } from "react";

/**
 * Live from Space — the 24/7 views from cameras on the ISS.
 *
 * Three public YouTube live streams, played through YouTube's privacy-preserving
 * nocookie embed. Switching tabs remounts the iframe (the `key`) so the new
 * stream starts cleanly rather than seeking the old player.
 */
const FEEDS = [
  { id: "4k", label: "4K Earth", yt: "fO9e9jnhYK8" },
  { id: "earth", label: "Earth View", yt: "tj4knR4r1UU" },
  { id: "overview", label: "Overview Cam", yt: "OKQEMp2555A" },
] as const;

type FeedId = (typeof FEEDS)[number]["id"];

export function SpacePanel() {
  const [feed, setFeed] = useState<FeedId>("4k");
  const active = FEEDS.find((f) => f.id === feed) ?? FEEDS[0];

  return (
    <div className="space-panel">
      <div className="space-video">
        <iframe
          key={active.yt}
          src={`https://www.youtube-nocookie.com/embed/${active.yt}?autoplay=1&mute=1&playsinline=1&modestbranding=1&rel=0`}
          title={active.label}
          allow="autoplay; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>
      <div className="space-tabs" role="tablist">
        {FEEDS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={f.id === feed}
            className={f.id === feed ? "on" : undefined}
            onClick={() => setFeed(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <dl className="space-stats">
        <div>
          <dt>Altitude</dt>
          <dd>~408 km</dd>
        </div>
        <div>
          <dt>Orbit</dt>
          <dd>~93 min</dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>ISS</dd>
        </div>
      </dl>
    </div>
  );
}
