import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Bluetooth radios known to this machine.
 *
 * Web Bluetooth is Chrome and Edge only, and even there it cannot enumerate:
 * it opens a chooser and returns the one device the operator picks. So the
 * browser path gives a list of one, in two browsers.
 *
 * `system_profiler` reads the same data the Bluetooth menu shows. It needs no
 * entitlement and no TCC grant, which matters here: talking to CoreBluetooth
 * directly (via bleak) aborts the process on macOS unless the caller is a
 * signed .app carrying NSBluetoothAlwaysUsageDescription, and Scout is not one.
 *
 * What this cannot do is discover unpaired strangers — that is a live scan, and
 * a live scan is exactly what needs the entitlement. This lists what the
 * machine already knows, with the RSSI macOS last measured for it.
 */
export interface BtRadio {
  name: string;
  address: string;
  connected: boolean;
  /** Signal strength in dBm, when macOS has a recent measurement. */
  rssi: number | null;
  /** "Headphones", "Phone", "Keyboard" — as macOS classifies it. */
  kind: string | null;
  vendorId: string | null;
  /** Percent, for devices that report it. AirPods report three. */
  battery: number | null;
}

export interface BtSnapshot {
  supported: boolean;
  /** Radio powered on. False means the list is whatever was last known. */
  poweredOn: boolean;
  controllerAddress: string | null;
  devices: BtRadio[];
  /** Why the list is empty, when it is empty for a reason worth saying. */
  note: string | null;
}

/** macOS reports battery as "100%" in some builds and 100 in others. */
function percent(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw.replace("%", "").trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function toNumber(raw: unknown): number | null {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return null;
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? null : n;
}

function readDevice(name: string, raw: Record<string, unknown>, connected: boolean): BtRadio {
  const battery =
    percent(raw["device_batteryLevelSingle"]) ??
    percent(raw["device_batteryLevelMain"]) ??
    percent(raw["device_batteryLevelCase"]) ??
    percent(raw["device_batteryLevelLeft"]) ??
    null;
  return {
    name,
    address: typeof raw["device_address"] === "string" ? raw["device_address"] : "",
    connected,
    rssi: toNumber(raw["device_rssi"]),
    kind:
      typeof raw["device_minorType"] === "string"
        ? raw["device_minorType"]
        : typeof raw["device_majorType"] === "string"
          ? raw["device_majorType"]
          : null,
    vendorId: typeof raw["device_vendorID"] === "string" ? raw["device_vendorID"] : null,
    battery,
  };
}

/**
 * Each entry is a single-key object: { "Will's iPhone": { …fields… } }. The
 * name is the key, which is why this cannot just be a field read.
 */
function readGroup(group: unknown, connected: boolean): BtRadio[] {
  if (!Array.isArray(group)) return [];
  return group.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const [name, fields] = Object.entries(entry as Record<string, unknown>)[0] ?? [];
    if (name === undefined || typeof fields !== "object" || fields === null) return [];
    return [readDevice(name, fields as Record<string, unknown>, connected)];
  });
}

export async function bluetoothSnapshot(): Promise<BtSnapshot> {
  if (process.platform !== "darwin") {
    return {
      supported: false,
      poweredOn: false,
      controllerAddress: null,
      devices: [],
      note: "Host scanning is macOS-only. Chrome and Edge can still pair a single device.",
    };
  }

  let parsed: unknown;
  try {
    const { stdout } = await run("system_profiler", ["SPBluetoothDataType", "-json"], {
      timeout: 15_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    parsed = JSON.parse(stdout);
  } catch {
    return {
      supported: false,
      poweredOn: false,
      controllerAddress: null,
      devices: [],
      note: "system_profiler did not answer.",
    };
  }

  const root = (parsed as { SPBluetoothDataType?: unknown[] }).SPBluetoothDataType;
  const block = Array.isArray(root) && typeof root[0] === "object" && root[0] !== null
    ? (root[0] as Record<string, unknown>)
    : {};
  const controller = (block["controller_properties"] ?? {}) as Record<string, unknown>;

  const devices = [
    ...readGroup(block["device_connected"], true),
    ...readGroup(block["device_not_connected"], false),
  ]
    // Connected first, then strongest signal — the order a proximity list wants.
    .sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return (b.rssi ?? -999) - (a.rssi ?? -999);
    });

  const poweredOn = controller["controller_state"] === "attrib_on";
  return {
    supported: true,
    poweredOn,
    controllerAddress:
      typeof controller["controller_address"] === "string" ? controller["controller_address"] : null,
    devices,
    note: poweredOn ? null : "Bluetooth is off. This is the last known list.",
  };
}
