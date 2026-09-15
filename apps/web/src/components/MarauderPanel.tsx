"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Marauder — nearby radios.
 *
 * Two sources, because neither is enough alone:
 *
 * - The host scan (`/live/bluetooth`) reads what macOS already knows, with the
 *   RSSI it last measured. Works in every browser, needs no permission, and is
 *   the reason this panel is no longer Chrome-only.
 * - Web Bluetooth pairs one new device at a time via the browser's own chooser.
 *   Chrome and Edge only. It cannot enumerate — that is a privacy rule of the
 *   API, not a gap here — so it supplements the host list rather than replacing
 *   it, and the button is hidden where the API is absent.
 *
 * Nothing leaves the machine. Export writes a file the operator saves.
 */

interface Radio {
  id: string;
  name: string;
  address: string;
  connected: boolean;
  rssi: number | null;
  kind: string | null;
  battery: number | null;
  services: string[];
  /** Host list vs. a device paired through the browser chooser. */
  origin: "host" | "paired";
}

interface Snapshot {
  supported: boolean;
  poweredOn: boolean;
  controllerAddress: string | null;
  devices: Array<{
    name: string;
    address: string;
    connected: boolean;
    rssi: number | null;
    kind: string | null;
    battery: number | null;
  }>;
  note: string | null;
}

interface BtDevice {
  id: string;
  name?: string;
  gatt?: {
    connect: () => Promise<{ getPrimaryServices: () => Promise<{ uuid: string }[]> }>;
  };
}
interface BtApi {
  requestDevice: (opts: { acceptAllDevices: boolean }) => Promise<BtDevice>;
}

function bluetooth(): BtApi | null {
  if (typeof navigator === "undefined") return null;
  return (navigator as unknown as { bluetooth?: BtApi }).bluetooth ?? null;
}

/** dBm to a four-step bar. -50 is in the room, -90 is through a wall. */
function bars(rssi: number | null): string {
  if (rssi === null) return "····";
  if (rssi >= -55) return "▮▮▮▮";
  if (rssi >= -70) return "▮▮▮·";
  if (rssi >= -85) return "▮▮··";
  return "▮···";
}

export function MarauderPanel() {
  const [host, setHost] = useState<Snapshot | null>(null);
  const [paired, setPaired] = useState<Radio[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const live = useRef<Map<string, BtDevice>>(new Map());

  // Web Bluetooth is absent during the server render, so this is resolved after
  // mount. Reading it during render would latch "unavailable" into the markup.
  const [canPair, setCanPair] = useState(false);
  useEffect(() => setCanPair(bluetooth() !== null), []);

  const write = (line: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/live/bluetooth");
      setHost((await response.json()) as Snapshot);
    } catch {
      setHost(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function pair() {
    const bt = bluetooth();
    if (bt === null) return;
    try {
      const device = await bt.requestDevice({ acceptAllDevices: true });
      live.current.set(device.id, device);
      const radio: Radio = {
        id: device.id,
        name: device.name?.trim() || "(unnamed)",
        address: "",
        connected: false,
        rssi: null,
        kind: null,
        battery: null,
        services: [],
        origin: "paired",
      };
      setPaired((d) => (d.some((x) => x.id === radio.id) ? d : [radio, ...d]));
      write(`paired ${radio.name}`);
    } catch (error) {
      // Dismissing the chooser rejects. That is a normal outcome.
      if (error instanceof Error && error.name !== "NotFoundError") write(`pair failed: ${error.message}`);
    }
  }

  async function readServices(radio: Radio) {
    const device = live.current.get(radio.id);
    if (device === undefined) return;
    try {
      const server = await device.gatt?.connect();
      const uuids = ((await server?.getPrimaryServices()) ?? []).map((s) => s.uuid);
      setPaired((d) => d.map((x) => (x.id === radio.id ? { ...x, connected: true, services: uuids } : x)));
      write(`${radio.name}: ${uuids.length} services`);
    } catch (error) {
      write(`read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const rows: Radio[] = [
    ...paired,
    ...(host?.devices ?? []).map((d) => ({
      id: d.address || d.name,
      name: d.name,
      address: d.address,
      connected: d.connected,
      rssi: d.rssi,
      kind: d.kind,
      battery: d.battery,
      services: [],
      origin: "host" as const,
    })),
  ];

  function download() {
    const body = JSON.stringify(rows, null, 2);
    const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "marauder-devices.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="marauder-panel">
      <div className="marauder-head">
        <span>
          {rows.length} {rows.length === 1 ? "Radio" : "Radios"}
        </span>
        <div className="mr-actions">
          <button type="button" onClick={() => void refresh()} disabled={busy}>
            {busy ? "Scanning…" : "Rescan"}
          </button>
          {canPair ? (
            <button type="button" onClick={() => void pair()}>
              Pair
            </button>
          ) : null}
        </div>
      </div>

      {host?.note !== null && host?.note !== undefined ? <p className="arcgis-note">{host.note}</p> : null}

      {rows.length === 0 ? (
        <p className="panel-empty">
          {host === null ? "Host scan unavailable." : "No radios in range."}
        </p>
      ) : (
        <ul className="marauder-list">
          {rows.map((d) => (
            <li key={`${d.origin}-${d.id}`}>
              <span className="mr-sig" title={d.rssi === null ? "No measurement" : `${d.rssi} dBm`}>
                {bars(d.rssi)}
              </span>
              <span className="mr-name">{d.name}</span>
              <span className="mr-id">
                {[d.address || null, d.kind, d.battery === null ? null : `${d.battery}%`]
                  .filter((x): x is string => x !== null)
                  .join(" · ")}
              </span>
              {d.origin === "paired" ? (
                <button type="button" onClick={() => void readServices(d)}>
                  {d.connected ? `${d.services.length} svc` : "Read"}
                </button>
              ) : (
                <span className={d.connected ? "mr-on" : "mr-off"}>{d.connected ? "Linked" : "Known"}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="marauder-vault">
        <button type="button" onClick={() => setShowLog((s) => !s)}>
          {showLog ? "Hide Log" : "Log"}
        </button>
        <button type="button" onClick={download} disabled={rows.length === 0}>
          Export
        </button>
      </div>

      {showLog ? <pre className="marauder-log">{log.join("\n") || "Nothing yet."}</pre> : null}
    </div>
  );
}
