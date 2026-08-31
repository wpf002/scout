"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The overview inset.
 *
 * A second map would double the tile budget and the memory for a thumbnail, so
 * this is drawn on a canvas from a coastline outline instead. It exists to
 * answer one question — where on Earth am I looking — which a picture of the
 * world with a box on it answers better than a scaled copy of the main map.
 */

interface Props {
  centre: { lat: number; lon: number };
  zoom: number;
  onJump: (place: { lat: number; lon: number }) => void;
}

const WIDTH = 168;
const HEIGHT = 84;

/** Equirectangular, which is what makes the maths a division. */
const project = (lon: number, lat: number): [number, number] => [
  ((lon + 180) / 360) * WIDTH,
  ((90 - lat) / 180) * HEIGHT,
];

export function Minimap({ centre, zoom, onJump }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [outline, setOutline] = useState<[number, number][][] | null>(null);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const context = element.getContext("2d");
    if (context === null) return;

    const ratio = window.devicePixelRatio || 1;
    element.width = WIDTH * ratio;
    element.height = HEIGHT * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);

    context.clearRect(0, 0, WIDTH, HEIGHT);
    context.fillStyle = "#0b0b13";
    context.fillRect(0, 0, WIDTH, HEIGHT);

    // Graticule, every thirty degrees. Enough to read position, faint enough
    // not to compete with the marker.
    context.strokeStyle = "rgba(255,255,255,0.08)";
    context.lineWidth = 0.5;
    for (let lon = -180; lon <= 180; lon += 30) {
      const [x] = project(lon, 0);
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, HEIGHT);
      context.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const [, y] = project(0, lat);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(WIDTH, y);
      context.stroke();
    }

    // The equator, marked.
    context.strokeStyle = "rgba(255,255,255,0.16)";
    const [, equator] = project(0, 0);
    context.beginPath();
    context.moveTo(0, equator);
    context.lineTo(WIDTH, equator);
    context.stroke();

    if (outline !== null) {
      context.strokeStyle = "rgba(90,200,250,0.5)";
      context.lineWidth = 0.6;
      for (const ring of outline) {
        context.beginPath();
        ring.forEach(([lon, lat], index) => {
          const [x, y] = project(lon, lat);
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.stroke();
      }
    }

    /*
     * The view box. Its size comes from the zoom — each level halves the span
     * — clamped so that at world zoom it does not draw a box larger than the
     * minimap, and at street zoom it stays big enough to see.
     */
    const spanLon = Math.min(360, Math.max(2, 360 / 2 ** zoom));
    const spanLat = Math.min(180, Math.max(1, 180 / 2 ** zoom));
    const [bx, by] = project(centre.lon - spanLon / 2, centre.lat + spanLat / 2);
    const boxW = (spanLon / 360) * WIDTH;
    const boxH = (spanLat / 180) * HEIGHT;

    context.strokeStyle = "#e0173a";
    context.lineWidth = 1;
    context.strokeRect(bx, by, Math.max(3, boxW), Math.max(3, boxH));

    const [cx, cy] = project(centre.lon, centre.lat);
    context.fillStyle = "#e0173a";
    context.beginPath();
    context.arc(cx, cy, 1.6, 0, Math.PI * 2);
    context.fill();
  }, [centre, zoom, outline]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/world-outline.json", { cache: "force-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<[number, number][][]>) : null))
      .then((data) => {
        if (!cancelled && data !== null) setOutline(data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <canvas
      ref={canvas}
      className="minimap"
      style={{ width: WIDTH, height: HEIGHT }}
      title="Click to jump"
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const lon = ((event.clientX - rect.left) / rect.width) * 360 - 180;
        const lat = 90 - ((event.clientY - rect.top) / rect.height) * 180;
        onJump({ lat, lon });
      }}
    />
  );
}
