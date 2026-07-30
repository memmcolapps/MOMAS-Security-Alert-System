import dgram from "node:dgram";
import { EventEmitter } from "node:events";
import net from "node:net";
import { randomUUID } from "node:crypto";
import {
  packControlFrame,
  packRtp,
  splitAmrFrames,
  unpackControlFrame,
  unpackRtp,
} from "./live-protocol";

type LiveClientOptions = {
  host: string;
  port: number;
  account: string;
  password: string;
  audioHost?: string;
  timeoutMs?: number;
};

type PendingRequest = {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type VoiceGroup = { gid: number; name: string; host: string; port: number };

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function ipCandidates(value: number) {
  const n = value >>> 0;
  return [
    [n >>> 24, n >>> 16, n >>> 8, n].map((part) => part & 255).join("."),
    [n, n >>> 8, n >>> 16, n >>> 24].map((part) => part & 255).join("."),
  ];
}

function usableIp(value: number, fallback: string) {
  if (!value) return fallback;
  const candidates = ipCandidates(value);
  return candidates.find((ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|22[4-9]\.|23\d\.)/.test(ip))
    || candidates[0];
}

export class PocstarsLiveClient extends EventEmitter {
  private options: LiveClientOptions;
  private control: net.Socket | null = null;
  private udp: dgram.Socket | null = null;
  private input = Buffer.alloc(0);
  private pending = new Map<string, PendingRequest[]>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private groupGeneration = 0;
  private connected = false;
  private closing = false;
  private kicked = false;
  private rtpSequence = Math.floor(Math.random() * 65536);
  private rtpTimestamp = Math.floor(Math.random() * 0xffffffff);
  private heartbeatSequence = 0;
  private speechId = "0";
  private watching = false;

  uid = 0;
  name = "";
  group: VoiceGroup | null = null;
  speaking = false;

  constructor(options: LiveClientOptions) {
    super();
    this.options = options;
  }

  async connect() {
    if (this.connected) return;
    this.closing = false;
    this.kicked = false;
    this.control = net.createConnection({
      host: this.options.host,
      port: this.options.port,
    });
    this.control.setNoDelay(true);
    this.control.on("data", (chunk) => this.readControl(Buffer.from(chunk)));
    this.control.on("error", (error) => this.fail(error));
    this.control.on("close", () => {
      this.connected = false;
      if (this.closing) return;
      this.fail(new Error(
        this.kicked
          ? "POCSTARS signed this dispatcher account in somewhere else and ended the radio session."
          : "POCSTARS voice connection closed.",
      ));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("POCSTARS voice server timed out.")), this.options.timeoutMs || 10_000);
      this.control?.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      this.control?.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const ack = await this.request("ptt.rr.Login", {
      account: this.options.account,
      password: this.options.password,
      roles: 3,
      platform: "TSS",
      device: "MOMAS",
      expectPayload: 101,
      acceptPayloads: [101],
    }, "ptt.rr.LoginAck");
    if (Number(ack.result) !== 0) {
      throw new Error(ack.what || `POCSTARS login failed (${ack.result}).`);
    }
    this.uid = Number(ack.self?.uid || 0);
    this.name = String(ack.self?.name || this.options.account);
    this.connected = true;
    this.emit("ready", { uid: this.uid, name: this.name });
  }

  async queryGroups() {
    const ack = await this.request("ptt.rr.QueryGroup", {
      detail: 1,
      timestamp: 0,
      includeBuiltin: true,
      includeStatic: true,
      includeTemp: true,
      includeCreated: true,
    }, "ptt.rr.QueryGroupAck");
    if (Number(ack.result) !== 0) throw new Error(`POCSTARS group query failed (${ack.result}).`);
    return ack.groups || [];
  }

  async queryContacts() {
    const ack = await this.request("ptt.rr.QueryContacts", {
      detail: 1,
      timestamp: 0,
      onlyOnline: false,
    }, "ptt.rr.QueryContactsAck");
    if (Number(ack.result) !== 0) throw new Error(`POCSTARS contact query failed (${ack.result}).`);
    return ack.users || [];
  }

  async queryMembers(groupIds: number[]) {
    if (!groupIds.length) return [];
    const ack = await this.request("ptt.rr.QueryMembers", {
      gids: groupIds,
      detail: 1,
      version2: false,
      allowPage: false,
    }, "ptt.rr.QueryMembersAck");
    if (Number(ack.result) !== 0) throw new Error(`POCSTARS group-member query failed (${ack.result}).`);
    return ack.members || [];
  }

  async queryInventory() {
    const groups = (await this.queryGroups())
      .filter((group: any) => Number(group.type) !== 2)
      .map((group: any) => ({
        id: Number(group.gid),
        name: String(group.name || `Group ${group.gid}`),
        type: Number(group.type || 0),
      }))
      .filter((group: any) => Number.isSafeInteger(group.id) && group.id > 0);
    // Some POCSTARS installations reject QueryContacts for dispatcher accounts
    // (the 143.105.173.49 install answers result 1 for every field combination).
    // Group membership still enumerates every visible radio, so fall back to it
    // rather than failing the whole inventory.
    const [contacts, memberLists] = await Promise.all([
      this.queryContacts().catch((error: Error) => {
        this.emit("warning", { command: "QueryContacts", message: error.message });
        return [] as any[];
      }),
      this.queryMembers(groups.map((group: any) => group.id)),
    ]);
    const radios = new Map<number, any>();
    const remember = (user: any) => {
      const uid = Number(user?.uid || 0);
      if (!Number.isSafeInteger(uid) || uid <= 0 || uid === this.uid) return;
      const current = radios.get(uid) || {};
      radios.set(uid, {
        id: uid,
        name: String(user?.name || current.name || `Radio ${uid}`),
        online: Boolean(user?.online),
        audioEnabled: user?.audioEnabled !== false,
        role: Number(user?.role || 0),
        departmentId: Number(user?.department || 0) || null,
      });
    };
    for (const contact of contacts) remember(contact);
    const memberships: Array<{ groupId: number; radioId: number }> = [];
    for (const memberList of memberLists) {
      const groupId = Number(memberList.gid || 0);
      for (const member of memberList.members || []) {
        remember(member);
        const radioId = Number(member.uid || 0);
        if (groupId > 0 && radioId > 0 && radioId !== this.uid) {
          memberships.push({ groupId, radioId });
        }
      }
    }
    return {
      dispatcher: { id: this.uid, name: this.name },
      groups,
      radios: [...radios.values()],
      memberships,
      observedAt: new Date().toISOString(),
    };
  }

  async startSingleCall(targetUid: number) {
    this.watching = false;
    const generation = this.groupGeneration;
    const ack = await this.request("ptt.rr.SingleCall", { uid: targetUid }, "ptt.rr.SingleCallAck");
    if (Number(ack.result) !== 0) throw new Error(`POCSTARS rejected the private call (${ack.result}).`);
    if (this.groupGeneration === generation) {
      await this.waitFor("group", 10_000);
    }
    if (!this.group) throw new Error("POCSTARS did not assign an audio channel.");
    return this.group;
  }

  async startWatchGroup(groupId: number) {
    if (!Number.isSafeInteger(groupId) || groupId <= 0) {
      throw new Error("Invalid POCSTARS group ID.");
    }
    const generation = this.groupGeneration;
    const ack = await this.request("ptt.rr.WatchGroup", {
      gid: groupId,
      uid: this.uid,
      expectPt: 101,
      acceptPt: [101],
      store: true,
    }, "ptt.rr.WatchGroupAck");
    if (Number(ack.result) !== 0) {
      throw new Error(`POCSTARS rejected group monitoring (${ack.result}).`);
    }

    const group = ack.group || {};
    const gid = Number(ack.gid || group.gid || groupId);
    const port = Number(group.port || 0);
    if (gid && port) {
      this.setGroup({
        gid,
        name: String(group.name || `Group ${gid}`),
        host: this.options.audioHost || usableIp(Number(group.ip || 0), this.options.host),
        port,
      });
    } else if (this.groupGeneration === generation) {
      await this.waitFor("group", 10_000);
    }
    if (!this.group) throw new Error("POCSTARS did not provide the group audio channel.");
    this.watching = true;
    return this.group;
  }

  async requestMic() {
    if (!this.group) throw new Error("No POCSTARS radio call is active.");
    const ack = await this.request("ptt.rr.RequestMic", {
      gid: this.group.gid,
      uid: this.uid,
      payload: 101,
      sessionId: randomUUID(),
      timestamp: nowSeconds(),
    }, "ptt.rr.RequestMicAck");
    if (Number(ack.result) !== 0) throw new Error(`The POCSTARS microphone is busy (${ack.reason || ack.result}).`);
    this.speechId = String(ack.speechId || "0");
    this.speaking = true;
    this.emit("mic", { speaking: true, speechId: this.speechId });
    return this.speechId;
  }

  async releaseMic() {
    if (!this.group || !this.speaking) return;
    this.speaking = false;
    try {
      await this.request("ptt.rr.ReleaseMic", {
        gid: this.group.gid,
        uid: this.uid,
        timestamp: nowSeconds(),
        speechId: this.speechId,
      }, "ptt.rr.ReleaseMicAck");
    } finally {
      this.emit("mic", { speaking: false, speechId: this.speechId });
      this.speechId = "0";
    }
  }

  sendAmr(data: Uint8Array) {
    if (!this.speaking || !this.group || !this.udp) return;
    for (const frame of splitAmrFrames(data)) {
      const packet = packRtp(101, this.rtpSequence++, this.rtpTimestamp, this.uid, frame);
      this.rtpTimestamp = (this.rtpTimestamp + 160) >>> 0;
      this.udp.send(packet, this.group.port, this.group.host);
    }
  }

  async endCall() {
    await this.releaseMic().catch(() => {});
    const group = this.group;
    this.stopAudio();
    if (group && this.control && !this.control.destroyed) {
      if (this.watching) {
        this.control.write(packControlFrame("ptt.rr.ByeGroup", { gid: group.gid, uid: this.uid }));
      } else {
        await this.request("ptt.rr.LeaveGroup", { gid: group.gid }, "ptt.rr.LeaveGroupAck").catch(() => {});
      }
    }
    this.watching = false;
    this.group = null;
  }

  async close() {
    this.closing = true;
    await this.endCall().catch(() => {});
    this.rejectPending(new Error("POCSTARS voice client closed."));
    this.control?.destroy();
    this.control = null;
    this.connected = false;
  }

  private request(name: string, value: Record<string, unknown>, ackName: string) {
    if (!this.control || this.control.destroyed) return Promise.reject(new Error("POCSTARS is not connected."));
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        const queue = this.pending.get(ackName) || [];
        this.pending.set(ackName, queue.filter((item) => item.resolve !== resolve));
        reject(new Error(`POCSTARS did not answer ${name}.`));
      }, this.options.timeoutMs || 10_000);
      const queue = this.pending.get(ackName) || [];
      queue.push({ resolve, reject, timer });
      this.pending.set(ackName, queue);
      this.control?.write(packControlFrame(name, value));
    });
  }

  private readControl(chunk: Buffer) {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= 4) {
      const length = this.input.readUInt32BE(0) + 4;
      if (length < 11 || length > 2 * 1024 * 1024) return this.fail(new Error("Invalid POCSTARS frame."));
      if (this.input.length < length) return;
      const packet = this.input.subarray(0, length);
      this.input = this.input.subarray(length);
      try {
        const message = unpackControlFrame(packet);
        this.handleMessage(message.name, message.value);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  private handleMessage(name: string, value: any) {
    const queue = this.pending.get(name);
    if (queue?.length) {
      const item = queue.shift()!;
      clearTimeout(item.timer);
      item.resolve(value);
      if (!queue.length) this.pending.delete(name);
      return;
    }
    if (name === "ptt.push.CurrentGroup") {
      const gid = Number(value.gid || value.group?.gid || 0);
      const port = Number(value.port || value.group?.port || 0);
      const ip = Number(value.ip || value.group?.ip || 0);
      if (gid && port) {
        this.setGroup({
          gid,
          name: String(value.gname || value.group?.name || `Call ${gid}`),
          host: this.options.audioHost || usableIp(ip, this.options.host),
          port,
        });
      }
      return;
    }
    // EChat allows one login per dispatcher account and evicts the older
    // session with this push, then closes the socket. Without it the operator
    // only sees a bare "connection closed" and no reason.
    if (name === "ptt.push.Kickout") {
      this.kicked = true;
      this.emit("error", new Error(
        "POCSTARS signed this dispatcher account in somewhere else and ended the radio session.",
      ));
      return;
    }
    if (name === "ptt.push.MemberGetMic") {
      this.emit("speaker", { uid: Number(value.uid), speaking: true });
    } else if (name === "ptt.push.MemberLostMic") {
      this.emit("speaker", { uid: Number(value.uid), speaking: false });
    } else if (name === "ptt.push.LostMic") {
      this.speaking = false;
      this.emit("mic", { speaking: false, reason: value.reason || "Microphone released by POCSTARS." });
    }
    this.emit("message", { name, value });
  }

  private startAudio() {
    this.stopAudio();
    if (!this.group) return;
    this.udp = dgram.createSocket("udp4");
    this.udp.on("message", (packet) => {
      const rtp = unpackRtp(packet);
      if (rtp?.payloadType === 101 && rtp.payload.length) {
        this.emit("audio", Buffer.from(rtp.payload), { uid: rtp.ssrc, timestamp: rtp.timestamp });
      }
    });
    this.udp.on("error", (error) => this.emit("error", error));
    this.udp.bind(0, () => {
      this.sendHeartbeat();
      this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), 5_000);
    });
  }

  private setGroup(group: VoiceGroup) {
    this.group = group;
    this.groupGeneration += 1;
    this.startAudio();
    this.emit("group", group);
  }

  private sendHeartbeat() {
    if (!this.group || !this.udp) return;
    const payload = packControlFrame("ptt.net.HeartBeat", {
      timestamp: nowSeconds(),
      gid: this.group.gid,
      uid: this.uid,
      seq: this.heartbeatSequence++,
    });
    this.udp.send(
      packRtp(100, this.rtpSequence++, nowSeconds(), this.uid, payload),
      this.group.port,
      this.group.host,
    );
  }

  private stopAudio() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.udp?.close();
    this.udp = null;
  }

  private waitFor(event: string, timeoutMs: number) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off(event, done);
        reject(new Error("POCSTARS audio channel timed out."));
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.once(event, done);
    });
  }

  private fail(error: Error) {
    this.rejectPending(error);
    this.emit("error", error);
  }

  private rejectPending(error: Error) {
    for (const queue of this.pending.values()) {
      for (const item of queue) {
        clearTimeout(item.timer);
        item.reject(error);
      }
    }
    this.pending.clear();
  }
}
