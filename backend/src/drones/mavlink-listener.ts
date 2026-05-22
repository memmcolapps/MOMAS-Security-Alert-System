/**
 * MAVLink TCP listener.
 *
 * Mission Planner (per drone, on its own computer) forwards its MAVLink
 * telemetry stream over TCP to this listener. We decode the few messages
 * needed to plot the drone on the map and keep the latest state per drone
 * in memory, keyed by MAVLink System ID (sysid).
 *
 * No external dependency: a self-contained MAVLink v1/v2 frame parser.
 * Each drone must have a unique SYSID_THISMAV in ArduPilot.
 */
import { env } from "../config";

// ── MAVLink message IDs we decode ─────────────────────────────────────────────
const MSG = {
  HEARTBEAT: 0,
  SYS_STATUS: 1,
  GPS_RAW_INT: 24,
  GLOBAL_POSITION_INT: 33,
  VFR_HUD: 74,
} as const;

// CRC_EXTRA seed byte per message (from the MAVLink message definitions).
// Used to validate frames for the messages we care about.
const CRC_EXTRA: Record<number, number> = {
  0: 50, // HEARTBEAT
  1: 124, // SYS_STATUS
  24: 24, // GPS_RAW_INT
  33: 104, // GLOBAL_POSITION_INT
  74: 20, // VFR_HUD
};

// Minimum (MAVLink v1) payload length per message. MAVLink v2 truncates
// trailing zero bytes, so we zero-pad up to this length before reading fields.
const PAYLOAD_LEN: Record<number, number> = {
  0: 9,
  1: 31,
  24: 30,
  33: 28,
  74: 20,
};

const STX_V1 = 0xfe;
const STX_V2 = 0xfd;
const ARMED_FLAG = 0x80; // MAV_MODE_FLAG_SAFETY_ARMED

// ── Live drone state (in memory, keyed by sysid) ──────────────────────────────
export type DroneState = {
  sysid: number;
  compid: number;
  lat: number | null;
  lon: number | null;
  alt_m: number | null;
  relative_alt_m: number | null;
  heading_deg: number | null;
  ground_speed_ms: number | null;
  satellites: number | null;
  gps_fix: number | null;
  armed: boolean | null;
  mav_type: number | null;
  system_status: number | null;
  custom_mode: number | null;
  battery_pct: number | null;
  battery_voltage: number | null;
  first_seen: number;
  last_seen: number;
};

const drones = new Map<number, DroneState>();

// ── X.25 CRC (MAVLink checksum) ───────────────────────────────────────────────
function mavlinkCrc(bytes: Uint8Array, start: number, end: number, crcExtra: number) {
  let crc = 0xffff;
  const accumulate = (b: number) => {
    let tmp = b ^ (crc & 0xff);
    tmp = (tmp ^ (tmp << 4)) & 0xff;
    crc = ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
  };
  for (let i = start; i < end; i++) accumulate(bytes[i]);
  accumulate(crcExtra);
  return crc;
}

type DecodedMessage = {
  msgid: number;
  sysid: number;
  compid: number;
  fields: Record<string, number | boolean | null>;
};

// ── Field decoding (little-endian, MAVLink wire order) ────────────────────────
function decodeFields(msgid: number, payload: Uint8Array): Record<string, number | boolean | null> {
  const size = Math.max(PAYLOAD_LEN[msgid] || payload.length, payload.length);
  const buf = new Uint8Array(size);
  buf.set(payload);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  switch (msgid) {
    case MSG.GLOBAL_POSITION_INT: {
      const hdg = dv.getUint16(26, true);
      return {
        lat: dv.getInt32(4, true) / 1e7,
        lon: dv.getInt32(8, true) / 1e7,
        alt: dv.getInt32(12, true) / 1000,
        relative_alt: dv.getInt32(16, true) / 1000,
        hdg: hdg === 65535 ? null : hdg / 100,
      };
    }
    case MSG.GPS_RAW_INT:
      return {
        lat: dv.getInt32(8, true) / 1e7,
        lon: dv.getInt32(12, true) / 1e7,
        alt: dv.getInt32(16, true) / 1000,
        fix_type: dv.getUint8(28),
        satellites_visible: dv.getUint8(29),
      };
    case MSG.HEARTBEAT: {
      const base_mode = dv.getUint8(6);
      return {
        custom_mode: dv.getUint32(0, true),
        type: dv.getUint8(4),
        autopilot: dv.getUint8(5),
        base_mode,
        system_status: dv.getUint8(7),
        armed: (base_mode & ARMED_FLAG) !== 0,
      };
    }
    case MSG.SYS_STATUS: {
      const mv = dv.getUint16(14, true);
      const remaining = dv.getInt8(30);
      return {
        voltage: mv ? mv / 1000 : null,
        remaining: remaining < 0 ? null : remaining,
      };
    }
    case MSG.VFR_HUD:
      return {
        groundspeed: dv.getFloat32(4, true),
        heading: dv.getInt16(16, true),
        throttle: dv.getUint16(18, true),
      };
    default:
      return {};
  }
}

// ── Per-connection frame parser ───────────────────────────────────────────────
class FrameParser {
  private buf = new Uint8Array(0);

  constructor(private onMessage: (msg: DecodedMessage) => void) {}

  push(chunk: Uint8Array) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    this.parse();
  }

  private parse() {
    const b = this.buf;
    let i = 0;

    while (i < b.length) {
      const stx = b[i];
      if (stx !== STX_V1 && stx !== STX_V2) {
        i++; // not a frame start — resync
        continue;
      }
      const isV2 = stx === STX_V2;
      const headerLen = isV2 ? 10 : 6;

      if (i + 2 > b.length) break; // need LEN byte
      const len = b[i + 1];

      let frameLen = headerLen + len + 2; // header + payload + CRC
      if (isV2) {
        if (i + 3 > b.length) break; // need incompat flags
        if (b[i + 2] & 0x01) frameLen += 13; // MAVLINK_IFLAG_SIGNED
      }
      if (i + frameLen > b.length) break; // wait for the rest of the frame

      let sysid: number;
      let compid: number;
      let msgid: number;
      if (isV2) {
        sysid = b[i + 5];
        compid = b[i + 6];
        msgid = b[i + 7] | (b[i + 8] << 8) | (b[i + 9] << 16);
      } else {
        sysid = b[i + 3];
        compid = b[i + 4];
        msgid = b[i + 5];
      }

      const payloadStart = i + headerLen;
      const crcExtra = CRC_EXTRA[msgid];

      if (crcExtra !== undefined) {
        // Validate CRC for messages we decode — this also keeps us in sync.
        const received = b[payloadStart + len] | (b[payloadStart + len + 1] << 8);
        const computed = mavlinkCrc(b, i + 1, payloadStart + len, crcExtra);
        if (received !== computed) {
          i++; // bad frame — step forward and resync
          continue;
        }
        this.onMessage({
          msgid,
          sysid,
          compid,
          fields: decodeFields(msgid, b.subarray(payloadStart, payloadStart + len)),
        });
      }
      // Unknown messages: trust the self-describing length and skip the frame.
      i += frameLen;
    }

    this.buf = b.subarray(i);
  }
}

// ── State update ──────────────────────────────────────────────────────────────
function handleMessage(msg: DecodedMessage) {
  const now = Date.now();
  let s = drones.get(msg.sysid);
  if (!s) {
    s = {
      sysid: msg.sysid,
      compid: msg.compid,
      lat: null,
      lon: null,
      alt_m: null,
      relative_alt_m: null,
      heading_deg: null,
      ground_speed_ms: null,
      satellites: null,
      gps_fix: null,
      armed: null,
      mav_type: null,
      system_status: null,
      custom_mode: null,
      battery_pct: null,
      battery_voltage: null,
      first_seen: now,
      last_seen: now,
    };
    drones.set(msg.sysid, s);
    console.log(`[MAVLink] new drone sysid=${msg.sysid}`);
  }
  s.last_seen = now;
  s.compid = msg.compid;
  const f = msg.fields;

  switch (msg.msgid) {
    case MSG.GLOBAL_POSITION_INT:
      s.lat = f.lat as number;
      s.lon = f.lon as number;
      s.alt_m = f.alt as number;
      s.relative_alt_m = f.relative_alt as number;
      s.heading_deg = f.hdg as number | null;
      break;
    case MSG.GPS_RAW_INT:
      s.gps_fix = f.fix_type as number;
      s.satellites = f.satellites_visible as number;
      if (s.lat == null && f.lat) {
        s.lat = f.lat as number;
        s.lon = f.lon as number;
      }
      break;
    case MSG.HEARTBEAT:
      s.mav_type = f.type as number;
      s.system_status = f.system_status as number;
      s.custom_mode = f.custom_mode as number;
      s.armed = f.armed as boolean;
      break;
    case MSG.SYS_STATUS:
      s.battery_voltage = f.voltage as number | null;
      s.battery_pct = f.remaining as number | null;
      break;
    case MSG.VFR_HUD:
      s.ground_speed_ms = f.groundspeed as number;
      if (s.heading_deg == null) s.heading_deg = f.heading as number;
      break;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
const parsers = new Map<unknown, FrameParser>();
let server: unknown = null;

/** Latest state for every tracked drone, with freshness flags. */
export function getDronePositions() {
  const now = Date.now();
  const staleMs = env.DRONE_STALE_SEC * 1000;
  const forgetMs = env.DRONE_FORGET_SEC * 1000;
  const out: Array<DroneState & { online: boolean; age_sec: number }> = [];
  for (const [sysid, s] of drones) {
    if (now - s.last_seen > forgetMs) {
      drones.delete(sysid);
      continue;
    }
    out.push({
      ...s,
      online: now - s.last_seen <= staleMs,
      age_sec: Math.round((now - s.last_seen) / 1000),
    });
  }
  return out;
}

export function getListenerStatus() {
  return {
    enabled: env.MAVLINK_ENABLE,
    host: env.MAVLINK_TCP_HOST,
    port: env.MAVLINK_TCP_PORT,
    connections: parsers.size,
    drones_tracked: drones.size,
  };
}

/** Start the TCP listener. Safe to call once at startup. */
export function startMavlinkListener() {
  if (!env.MAVLINK_ENABLE) {
    console.log("[MAVLink] listener disabled (MAVLINK_ENABLE=false)");
    return;
  }
  try {
    server = (Bun as any).listen({
      hostname: env.MAVLINK_TCP_HOST,
      port: env.MAVLINK_TCP_PORT,
      socket: {
        open(socket: any) {
          parsers.set(socket, new FrameParser(handleMessage));
          console.log(`[MAVLink] connection opened from ${socket.remoteAddress || "unknown"}`);
        },
        data(socket: any, data: Uint8Array) {
          parsers.get(socket)?.push(new Uint8Array(data));
        },
        close(socket: any) {
          parsers.delete(socket);
          console.log("[MAVLink] connection closed");
        },
        error(socket: any, error: Error) {
          parsers.delete(socket);
          console.error("[MAVLink] socket error:", error?.message || error);
        },
      },
    });
    console.log(`[MAVLink] TCP listener on ${env.MAVLINK_TCP_HOST}:${env.MAVLINK_TCP_PORT}`);
  } catch (error) {
    console.error(
      "[MAVLink] failed to start listener:",
      error instanceof Error ? error.message : error,
    );
  }
}
