"use client";

import { useRef, useState } from "react";

/**
 * Marauder — a Web Bluetooth device scanner.
 *
 * Web Bluetooth cannot silently enumerate nearby radios; for privacy the
 * browser shows its own chooser and hands back the one device the user picks.
 * So "Scan" opens that chooser, and each pick is added here. Connecting reads
 * the device's advertised GATT services. Chrome/Edge only, over HTTPS or
 * localhost — elsewhere navigator.bluetooth is absent and the panel says so.
 *
 * Everything stays in this browser tab: nothing is sent anywhere. Export writes
 * a file the viewer saves themselves.
 */

interface Seen {
  id: string;
  name: string;
  connected: boolean;
  services: string[];
  at: number;
}

type Tab = "devices" | "intel" | "log";

// Minimal shape of the Web Bluetooth API we touch, so this compiles without
// DOM lib "bluetooth" types.
interface BtDevice {
  id: string;
  name?: string;
  gatt?: {
    connect: () => Promise<{
      getPrimaryServices: () => Promise<{ uuid: string }[]>;
    }>;
  };
}
interface BtApi {
  requestDevice: (opts: { acceptAllDevices: boolean; optionalServices?: string[] }) => Promise<BtDevice>;
}

function bluetooth(): BtApi | null {
  if (typeof navigator === "undefined") return null;
  const bt = (navigator as unknown as { bluetooth?: BtApi }).bluetooth;
  return bt ?? null;
}

export function MarauderPanel() {
  const [tab, setTab] = useState<Tab>("devices");
  const [devices, setDevices] = useState<Seen[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  // The live BluetoothDevice objects, kept out of state so they are not walked
  // by JSON export and survive re-renders.
  const live = useRef<Map<string, BtDevice>>(new Map());

  const available = bluetooth() !== null;
  const write = (line: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));

  async function scan() {
    const bt = bluetooth();
    if (bt === null) return;
    setBusy(true);
    try {
      const device = await bt.requestDevice({ acceptAllDevices: true });
      live.current.set(device.id, device);
      const seen: Seen = {
        id: device.id,
        name: device.name?.trim() || "(unnamed)",
        connected: false,
        services: [],
        at: Date.now(),
      };
      setDevices((d) => (d.some((x) => x.id === seen.id) ? d : [seen, ...d]));
      write(`paired ${seen.name} [${seen.id.slice(0, 8)}]`);
    } catch (error) {
      // The chooser being dismissed rejects; that is a normal outcome, not a
      // failure worth shouting about.
      write(`scan cancelled${error instanceof Error && error.name !== "NotFoundError" ? `: ${error.message}` : ""}`);
    } finally {
      setBusy(false);
    }
  }

  async function connect(seen: Seen) {
    const device = live.current.get(seen.id);
    if (device === undefined) return;
    try {
      const server = await device.gatt?.connect();
      const services = (await server?.getPrimaryServices()) ?? [];
      const uuids = services.map((s) => s.uuid);
      setDevices((d) =>
        d.map((x) => (x.id === seen.id ? { ...x, connected: true, services: uuids } : x)),
      );
      write(`connected ${seen.name}: ${uuids.length} services`);
    } catch (error) {
      write(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function download(kind: "json" | "csv") {
    const body =
      kind === "json"
        ? JSON.stringify(devices, null, 2)
        : ["id,name,connected,services,seen", ...devices.map((d) =>
            [d.id, d.name, d.connected, d.services.join("|"), new Date(d.at).toISOString()].join(","),
          )].join("\n");
    const blob = new Blob([body], { type: kind === "json" ? "application/json" : "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `marauder-devices.${kind}`;
    a.click();
    URL.revokeObjectURL(url);
    write(`exported ${devices.length} device(s) as ${kind.toUpperCase()}`);
  }

  return (
    <div className="marauder-panel">
      <div className="marauder-head">
        <span>{devices.length} DEVS</span>
        <button type="button" onClick={scan} disabled={!available || busy}>
          {busy ? "SCANNING…" : "SCAN"}
        </button>
      </div>

      {!available ? (
        <p className="panel-empty">Web Bluetooth unavailable — use Chrome or Edge over HTTPS or localhost.</p>
      ) : (
        <>
          <div className="marauder-tabs" role="tablist">
            {(["devices", "intel", "log"] as Tab[]).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={t === tab}
                className={t === tab ? "on" : undefined}
                onClick={() => setTab(t)}
              >
                {t === "devices" ? "Devices" : t === "intel" ? "Intel" : "Log"}
              </button>
            ))}
          </div>

          {tab === "devices" ? (
            devices.length === 0 ? (
              <p className="panel-empty">No devices yet. Press SCAN and pick one from the browser chooser.</p>
            ) : (
              <ul className="marauder-list">
                {devices.map((d) => (
                  <li key={d.id}>
                    <span className="mr-name">{d.name}</span>
                    <span className="mr-id">{d.id.slice(0, 12)}</span>
                    <button type="button" onClick={() => connect(d)}>
                      {d.connected ? `${d.services.length} svc` : "Connect"}
                    </button>
                  </li>
                ))}
              </ul>
            )
          ) : null}

          {tab === "intel" ? (
            <div className="marauder-intel">
              <h3>GATT services</h3>
              {devices.filter((d) => d.connected).length === 0 ? (
                <p className="panel-empty">Connect a device to read its advertised services.</p>
              ) : (
                <ul className="marauder-list">
                  {devices
                    .filter((d) => d.connected)
                    .map((d) => (
                      <li key={d.id} className="mr-svc">
                        <span className="mr-name">{d.name}</span>
                        <span className="mr-id">{d.services.join(", ") || "none"}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          ) : null}

          {tab === "log" ? (
            <pre className="marauder-log">{log.join("\n") || "No activity yet."}</pre>
          ) : null}

          <div className="marauder-vault">
            <span>
              VAULT · {devices.length} device{devices.length === 1 ? "" : "s"}
            </span>
            <div>
              <button type="button" onClick={() => download("json")} disabled={devices.length === 0}>
                JSON
              </button>
              <button type="button" onClick={() => download("csv")} disabled={devices.length === 0}>
                CSV
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  setDevices([]);
                  live.current.clear();
                  write("vault wiped");
                }}
                disabled={devices.length === 0}
              >
                Wipe
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
