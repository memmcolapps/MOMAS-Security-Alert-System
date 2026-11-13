import axios from "axios";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { env } from "../config";
import { Hono } from "hono";
import * as db from "../db";
import { ensureDeviceAccess, formUrlencoded, isPlatformAdmin, orgScope, statusFromAxios } from "./pocstars-helpers";

// Push-to-talk recordings: listing them from the vendor, and serving each one
// as MP3 behind a short-lived ticket. Mounted inside routes/pocstars.ts, which
// applies sign-in to everything here.
const router = new Hono();

const LOC_BASE = env.POCSTARS_LOC_BASE;
const DISPATCHER_UID = env.POCSTARS_DISPATCHER_UID;

const RECORDINGS_BASE = env.POCSTARS_RECORDINGS_BASE;
const RECORDINGS_USERNAME = env.POCSTARS_RECORDINGS_USERNAME;
const RECORDINGS_PASSWORD = env.POCSTARS_RECORDINGS_PASSWORD;

const RECORDING_TICKET_TTL_MS = 10 * 60 * 1000;
const RECORDING_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_RECORDING_BYTES = 20 * 1024 * 1024;

type RecordingTicket = {
  path: string;
  speakerUserId: string;
  expiresAt: number;
};

const recordingTickets = new Map<string, RecordingTicket>();
const ticketByRecording = new Map<string, string>();
const transcodedRecordingCache = new Map<
  string,
  { data: Buffer; expiresAt: number }
>();

function cleanRecordingCaches() {
  const now = Date.now();
  for (const [token, ticket] of recordingTickets) {
    if (ticket.expiresAt > now) continue;
    recordingTickets.delete(token);
    ticketByRecording.delete(`${ticket.speakerUserId}:${ticket.path}`);
  }
  for (const [path, entry] of transcodedRecordingCache) {
    if (entry.expiresAt <= now) transcodedRecordingCache.delete(path);
  }
}

function recordingTicket(path: string, speakerUserId: string) {
  cleanRecordingCaches();
  const key = `${speakerUserId}:${path}`;
  const currentToken = ticketByRecording.get(key);
  const current = currentToken ? recordingTickets.get(currentToken) : null;
  if (current && current.expiresAt > Date.now()) return currentToken as string;

  const token = crypto.randomBytes(24).toString("base64url");
  recordingTickets.set(token, {
    path,
    speakerUserId,
    expiresAt: Date.now() + RECORDING_TICKET_TTL_MS,
  });
  ticketByRecording.set(key, token);
  return token;
}

function basicRecordingAuthorization() {
  if (!RECORDINGS_USERNAME || !RECORDINGS_PASSWORD) return null;
  return `Basic ${Buffer.from(`${RECORDINGS_USERNAME}:${RECORDINGS_PASSWORD}`).toString("base64")}`;
}

function recordingFileUrl(path: string) {
  const base = RECORDINGS_BASE.endsWith("/")
    ? RECORDINGS_BASE
    : `${RECORDINGS_BASE}/`;
  return new URL(String(path).replace(/^\/+/, ""), base).toString();
}

async function transcodeAmrToMp3(rawAudio: Buffer) {
  const input =
    rawAudio.subarray(0, 6).toString("ascii") === "#!AMR\n"
      ? rawAudio
      : Buffer.concat([Buffer.from("#!AMR\n"), rawAudio]);

  return new Promise<Buffer>((resolve, reject) => {
    const process = spawn(
      ffmpeg.path,
      [
        "-hide_banner",
        "-loglevel",
        "fatal",
        "-f",
        "amr",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        "8000",
        "-codec:a",
        "libmp3lame",
        "-b:a",
        "32k",
        "-f",
        "mp3",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;

    process.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_RECORDING_BYTES) {
        process.kill();
        reject(new Error("Transcoded radio clip exceeded the size limit."));
        return;
      }
      output.push(chunk);
    });
    process.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    process.on("error", reject);
    process.on("close", (code) => {
      const result = Buffer.concat(output);
      const hasMp3Header =
        result.subarray(0, 3).toString("ascii") === "ID3" ||
        (result[0] === 0xff && (result[1] & 0xe0) === 0xe0);
      if (!result.length || (code !== 0 && !hasMp3Header)) {
        const detail = Buffer.concat(errors)
          .toString("utf8")
          .trim()
          .slice(0, 500);
        reject(new Error(detail || "The radio audio could not be decoded."));
        return;
      }
      resolve(result);
    });
    process.stdin.end(input);
  });
}

async function fetchAndTranscodeRecording(path: string) {
  cleanRecordingCaches();
  const cached = transcodedRecordingCache.get(path);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const authorization = basicRecordingAuthorization();
  if (!authorization) {
    const error: any = new Error("Radio recording access is not configured.");
    error.status = 503;
    throw error;
  }

  const response = await fetch(recordingFileUrl(path), {
    headers: { Authorization: authorization },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const error: any = new Error(
      `The recording server returned ${response.status}.`,
    );
    error.status = 502;
    throw error;
  }
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_RECORDING_BYTES) {
    const error: any = new Error("Radio clip is too large to play.");
    error.status = 413;
    throw error;
  }
  const raw = Buffer.from(await response.arrayBuffer());
  if (!raw.length) {
    const error: any = new Error(
      "The recording server returned an empty clip.",
    );
    error.status = 502;
    throw error;
  }
  if (raw.length > MAX_RECORDING_BYTES) {
    const error: any = new Error("Radio clip is too large to play.");
    error.status = 413;
    throw error;
  }

  const data = await transcodeAmrToMp3(raw);
  if (transcodedRecordingCache.size >= 100) {
    const oldest = transcodedRecordingCache.keys().next().value;
    if (oldest) transcodedRecordingCache.delete(oldest);
  }
  transcodedRecordingCache.set(path, {
    data,
    expiresAt: Date.now() + RECORDING_CACHE_TTL_MS,
  });
  return data;
}

router.get("/radio/recordings", async (c) => {
  const query = c.req.query();
  const pageIndex = Math.max(
    1,
    Number.parseInt(query.pageIndex || "1", 10) || 1,
  );
  const pageSize = Math.min(
    50,
    Math.max(1, Number.parseInt(query.pageSize || "20", 10) || 20),
  );
  const speakerUserId = String(query.speakerUserId || "").trim();
  const groupName = String(query.groupName || "")
    .trim()
    .slice(0, 200);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(query.from || "") ? query.from : "";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(query.to || "") ? query.to : "";

  if (!DISPATCHER_UID) {
    return c.json(
      {
        error: "radio_recordings_not_configured",
        message: "Radio recordings are not configured.",
      },
      503,
    );
  }
  if (speakerUserId && !(await ensureDeviceAccess(c, [speakerUserId]))) {
    return c.json(
      {
        error: "forbidden",
        message: "That radio is outside your operational scope.",
      },
      403,
    );
  }

  try {
    const devices = await db.listDevices(orgScope(c));
    const allowedSpeakers = new Set(
      devices.map((device: any) => String(device.device_id)),
    );
    const form: Record<string, unknown> = {
      pageIndex,
      pageSize,
      uid: DISPATCHER_UID,
    };
    if (groupName) form.groupName = groupName;
    if (from || to) form.callIdDate = `${from || to} ~ ${to || from}`;

    const { data } = await axios.post(
      `${LOC_BASE.replace(/\/$/, "")}/speakRecord/queryList`,
      formUrlencoded(form),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 15_000,
      },
    );
    if (data?.success === false || Number(data?.code) !== 200) {
      return c.json(
        {
          error: "pocstars_recordings_failed",
          message: data?.message || "No radio recordings were returned.",
        },
        502,
      );
    }

    const rows = Array.isArray(data?.data?.speakRecordList)
      ? data.data.speakRecordList
      : [];
    const recordings = rows
      .filter((row: any) => {
        const rowSpeaker = String(row.Rc_SpeakerUserID ?? "");
        if (!row.Rc_SavePath || !rowSpeaker) return false;
        if (speakerUserId && rowSpeaker !== speakerUserId) return false;
        return isPlatformAdmin(c) || allowedSpeakers.has(rowSpeaker);
      })
      .map((row: any) => {
        const rowSpeaker = String(row.Rc_SpeakerUserID);
        return {
          id: String(row.Rc_ID),
          groupId:
            row.Rc_ChatGroupID == null ? null : String(row.Rc_ChatGroupID),
          groupName: row.Rc_ChatGroupName || null,
          groupType: row.Rc_GroupType ?? null,
          speakerUserId: rowSpeaker,
          speakerName: row.Rc_SpeakerUserName || null,
          startedAt: row.Rc_SpeakStartTime || row.SpeakStartTime || null,
          durationMs: Number(row.Rc_SpeakTimeOfMilliSecond || 0),
          codec: String(row.Rc_CodeFormat || ""),
          playbackToken: recordingTicket(String(row.Rc_SavePath), rowSpeaker),
        };
      });

    return c.json({
      recordings,
      pageIndex: Number(data?.data?.pageIndex || pageIndex),
      pageSize: Number(data?.data?.pageSize || pageSize),
      pageCount: Number(data?.data?.pageCount || 0),
      refreshAfterMs: 3_000,
    });
  } catch (error: any) {
    return c.json(
      {
        error: "pocstars_recordings_failed",
        message: "Radio traffic is temporarily unavailable.",
      },
      statusFromAxios(error),
    );
  }
});

router.get("/radio/recordings/:token/audio", async (c) => {
  cleanRecordingCaches();
  const token = c.req.param("token");
  const ticket = recordingTickets.get(token);
  if (!ticket || ticket.expiresAt <= Date.now()) {
    return c.json(
      {
        error: "recording_link_expired",
        message: "Refresh the radio traffic list and try again.",
      },
      410,
    );
  }
  if (!(await ensureDeviceAccess(c, [ticket.speakerUserId]))) {
    return c.json(
      {
        error: "forbidden",
        message: "That radio is outside your operational scope.",
      },
      403,
    );
  }

  try {
    const audio = await fetchAndTranscodeRecording(ticket.path);
    return new Response(audio, {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(audio.length),
        "Cache-Control": "private, max-age=300",
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error: any) {
    return c.json(
      {
        error: "pocstars_recording_playback_failed",
        message: error?.message || "This radio clip could not be played.",
      },
      error?.status || 502,
    );
  }
});

export default router;
