import { EventEmitter } from "node:events";

type BridgeClientOptions = {
  url: string;
  token: string;
  timeoutMs?: number;
};

type Waiter = {
  accept: (message: any) => boolean;
  resolve: (message: any) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class PocstarsBridgeClient extends EventEmitter {
  private options: BridgeClientOptions;
  private socket: WebSocket | null = null;
  private waiters = new Set<Waiter>();
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private speakerUid = 0;
  private provisionSequence = 0;
  private mode: "private" | "monitor" | null = null;

  group: { gid: number; name: string } | null = null;
  speaking = false;

  constructor(options: BridgeClientOptions) {
    super();
    this.options = options;
  }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.closing = false;
    const url = new URL(this.options.url);
    url.searchParams.set("token", this.options.token);
    const ready = this.waitFor((message) => message.type === "ready");
    const socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    socket.onmessage = (event) => this.receive(event.data);
    socket.onerror = () => this.fail(new Error("Could not connect to the radio link."));
    socket.onclose = () => {
      this.socket = null;
      this.stopKeepalive();
      if (!this.closing) this.fail(new Error("The radio link connection closed."));
    };
    await ready;
    // Monitoring is silent for long stretches, so without this the bridge's
    // idle reaper would drop a perfectly healthy listening session.
    this.keepaliveTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: "ping" }));
      }
    }, 25_000);
  }

  async startSingleCall(targetUid: number, companyId?: number | null) {
    const response = await this.request(
      { type: "call.start", deviceId: targetUid, companyId: companyId ?? null },
      (message) => message.type === "call.state" && message.state === "connected",
    );
    this.group = {
      gid: Number(response.group?.id || 0),
      name: String(response.group?.name || `Call ${targetUid}`),
    };
    this.mode = "private";
    return this.group;
  }

  async startWatchGroup(groupId: number, companyId?: number | null) {
    const response = await this.request(
      { type: "monitor.start", groupId, companyId: companyId ?? null },
      (message) => message.type === "monitor.state" && message.state === "connected",
    );
    this.group = {
      gid: Number(response.group?.id || groupId),
      name: String(response.group?.name || `Group ${groupId}`),
    };
    this.mode = "monitor";
    return this.group;
  }

  // Opens the long-lived presence session and returns the baseline. Deltas
  // arrive afterwards as "presence.delta" messages, which callers pick up from
  // the message event rather than by asking.
  async watchPresence(companyId: number) {
    const response = await this.request(
      { type: "presence.watch", companyId },
      (message) => message.type === "presence.baseline",
    );
    return {
      seat: String(response.seat || ""),
      radios: Array.isArray(response.radios) ? response.radios : [],
    };
  }

  async queryInventory() {
    return this.request(
      { type: "inventory.query" },
      (message) => message.type === "inventory.result",
    ).then((message) => message.inventory);
  }

  async requestMic() {
    await this.request(
      { type: "ptt.start" },
      (message) => message.type === "ptt.state" && message.state === "granted",
    );
    this.speaking = true;
  }

  async releaseMic() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    await this.request(
      { type: "ptt.stop" },
      (message) => message.type === "ptt.state" && message.state === "idle",
    );
    this.speaking = false;
  }

  sendAmr(data: Uint8Array) {
    if (this.speaking && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(data);
    }
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  async close() {
    this.closing = true;
    this.speaking = false;
    this.group = null;
    this.stopKeepalive();
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: this.mode === "monitor" ? "monitor.end" : "call.end" }));
    }
    this.mode = null;
    this.socket?.close();
    this.socket = null;
    this.rejectWaiters(new Error("The radio link client closed."));
  }

  // Provisioning is request/response over the same authenticated socket. Each
  // call carries an id so concurrent commands cannot be confused for one
  // another, and errors come back as a result rather than as a socket-level
  // failure - a rejected provisioning command must not tear down the link.
  async provision(command: string, payload: Record<string, unknown> = {}) {
    const requestId = ++this.provisionSequence;
    const response = await this.request(
      { type: command, requestId, ...payload },
      (message: any) => message.type === "provision.result" && message.requestId === requestId,
    );
    if (!response.ok) {
      throw new Error(response.error || `The radio network rejected ${command}.`);
    }
    return response.result;
  }

  private request(value: Record<string, unknown>, accept: (message: any) => boolean) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("The radio link is not connected."));
    }
    const response = this.waitFor(accept);
    this.socket.send(JSON.stringify(value));
    return response;
  }

  private waitFor(accept: (message: any) => boolean) {
    return new Promise<any>((resolve, reject) => {
      const waiter: Waiter = {
        accept,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("The radio link timed out."));
        }, this.options.timeoutMs || 15_000),
      };
      this.waiters.add(waiter);
    });
  }

  private receive(data: string | ArrayBuffer | Blob) {
    if (typeof data !== "string") {
      if (data instanceof ArrayBuffer) {
        this.emit("audio", Buffer.from(data), { uid: this.speakerUid });
      }
      return;
    }
    let message: any;
    try {
      message = JSON.parse(data);
    } catch {
      this.fail(new Error("The radio link returned an invalid message."));
      return;
    }
    if (message.type === "error") {
      const error = new Error(message.message || "The radio link reported an error.");
      this.rejectWaiters(error);
      this.emit("error", error);
      return;
    }
    for (const waiter of this.waiters) {
      if (!waiter.accept(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
      break;
    }
    if (message.type === "speaker") {
      if (message.speaking) this.speakerUid = Number(message.uid || 0);
      this.emit("speaker", {
        uid: Number(message.uid || 0),
        speaking: Boolean(message.speaking),
      });
    } else if (message.type === "ptt.state") {
      this.speaking = message.state === "granted";
      this.emit("mic", {
        speaking: this.speaking,
        reason: message.reason,
      });
    } else if (message.type === "presence.delta") {
      this.emit("presence", Array.isArray(message.users) ? message.users : []);
    }
  }

  private fail(error: Error) {
    this.rejectWaiters(error);
    if (!this.closing) this.emit("error", error);
  }

  private rejectWaiters(error: Error) {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}
