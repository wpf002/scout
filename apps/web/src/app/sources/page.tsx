"use client";

import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { TIER_BLURB, TIER_ORDER } from "@/lib/types";
import type { SourceSummary } from "@/lib/types";
import { Loading } from "@/components/Loading";

export default function SourcesPage() {
  const [sources, setSources] = useState<SourceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .sources()
      .then((result) => setSources(result.sources))
      .catch((caught: unknown) => {
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Failed to load the registry.",
        );
        setSources([]);
      });
  }, []);

  return (
    <>
      <div className="band">
        <span className="eyebrow">Reach-for order</span>
        <h1>Start where nobody gets hurt.</h1>
        <p>
          Datasets and infrastructure do most of the work and touch no personal
          data. The scoped tiers sit lower on purpose, and a source with no key
          reports inert rather than guessing.
        </p>
      </div>

      {error !== null && <div className="error">{error}</div>}
      {sources === null && <Loading what="the source registry" />}

      {sources !== null &&
        TIER_ORDER.map((tier, index) => {
          const inTier = sources.filter((source) => source.tier === tier);
          if (inTier.length === 0) return null;

          return (
            <section key={tier}>
              <div className="tier-head">
                <span className="n">{index + 1}</span>
                <h2>{tier}</h2>
                <span className="blurb">{TIER_BLURB[tier]}</span>
              </div>

              {inTier.map((source) => (
                <div className="entry" key={source.id}>
                  <div className="spread">
                    <div>
                      <div className="entry-title">
                        {source.name}{" "}
                        <span className="faint mono" style={{ fontWeight: 400 }}>
                          {source.id}
                        </span>
                      </div>
                      <div className="entry-desc">{source.description}</div>
                      <div className="entry-desc faint">
                        accepts: {source.accepts.join(", ")}
                      </div>
                    </div>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {source.requiresScope && (
                        <span className="badge scoped">scoped</span>
                      )}
                      <span className="badge">{source.mode}</span>
                      {source.mode === "api" &&
                        (source.keyed ? (
                          <span className="badge ok">keyed</span>
                        ) : (
                          <span className="badge warn">inert</span>
                        ))}
                      {source.mode === "api" && !source.hasAdapter && (
                        <span className="badge">no adapter</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </section>
          );
        })}
    </>
  );
}
