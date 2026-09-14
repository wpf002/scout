"use client";

import { useEffect, useRef } from "react";

/**
 * An HLS live stream in a <video>. hls.js is imported on mount and only in the
 * browser — this component is loaded with next/dynamic ssr:false — so the
 * browser-only library never enters the server or prerender bundle. Safari
 * plays HLS natively and skips the import.
 */
export default function HlsVideo({ src, label }: { src: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    if (video.canPlayType("application/vnd.apple.mpegurl") !== "") {
      video.src = src;
      return;
    }
    let destroyed = false;
    let instance: { destroy: () => void } | null = null;
    void import("hls.js").then(({ default: Hls }) => {
      const el = videoRef.current;
      if (destroyed || el === null) return;
      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.loadSource(src);
        hls.attachMedia(el);
        instance = hls;
      } else {
        el.src = src;
      }
    });
    return () => {
      destroyed = true;
      instance?.destroy();
    };
  }, [src]);

  return (
    <video
      ref={videoRef}
      className="detail-video"
      controls
      autoPlay
      muted
      playsInline
      aria-label={label}
    />
  );
}
