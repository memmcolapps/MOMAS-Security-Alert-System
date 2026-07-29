import protobuf from "protobufjs";

const { Root, Type } = protobuf;

const root = Root.fromJSON({
  nested: {
    ptt: {
      nested: {
        User: {
          fields: {
            uid: { type: "uint32", id: 1 },
            timestamp: { type: "uint32", id: 2 },
            name: { type: "string", id: 3 },
            online: { type: "bool", id: 4 },
            audioEnabled: { type: "bool", id: 5 },
            sleep: { type: "bool", id: 6 },
            dnd: { type: "bool", id: 7 },
            role: { type: "int32", id: 8 },
            department: { type: "uint32", id: 9 },
          },
        },
        Group: {
          fields: {
            gid: { type: "uint32", id: 1 },
            timestamp: { type: "uint32", id: 2 },
            name: { type: "string", id: 3 },
            type: { type: "int32", id: 4 },
            ip: { type: "uint32", id: 6 },
            port: { type: "uint32", id: 7 },
          },
        },
        Configure: {
          fields: {
            defaultGroup: { type: "uint32", id: 1 },
            defaultGroupInfo: { type: "ptt.Group", id: 9 },
          },
        },
        GroupMembers: {
          fields: {
            gid: { type: "uint32", id: 1 },
            ingroups: { rule: "repeated", type: "uint32", id: 2 },
            outgroups: { rule: "repeated", type: "uint32", id: 3 },
            members: { rule: "repeated", type: "ptt.User", id: 4 },
          },
        },
        rr: {
          nested: {
            Login: {
              fields: {
                account: { type: "string", id: 1 },
                password: { type: "string", id: 2 },
                roles: { type: "uint32", id: 3 },
                platform: { type: "string", id: 5 },
                device: { type: "string", id: 6 },
                expectPayload: { type: "uint32", id: 7 },
                acceptPayloads: { rule: "repeated", type: "uint32", id: 8 },
              },
            },
            LoginAck: {
              fields: {
                result: { type: "int32", id: 1 },
                self: { type: "ptt.User", id: 2 },
                conf: { type: "ptt.Configure", id: 3 },
                what: { type: "string", id: 4 },
              },
            },
            SingleCall: { fields: { uid: { type: "uint32", id: 1 } } },
            SingleCallAck: { fields: { result: { type: "int32", id: 1 } } },
            QueryGroup: {
              fields: {
                detail: { type: "int32", id: 1 },
                timestamp: { type: "uint32", id: 2 },
                includeBuiltin: { type: "bool", id: 3 },
                includeStatic: { type: "bool", id: 4 },
                includeTemp: { type: "bool", id: 5 },
                includeCreated: { type: "bool", id: 6 },
              },
            },
            QueryGroupAck: {
              fields: {
                result: { type: "int32", id: 1 },
                groups: { rule: "repeated", type: "ptt.Group", id: 2 },
              },
            },
            QueryContacts: {
              fields: {
                detail: { type: "int32", id: 1 },
                timestamp: { type: "uint32", id: 2 },
                onlyOnline: { type: "bool", id: 3 },
              },
            },
            QueryContactsAck: {
              fields: {
                result: { type: "int32", id: 1 },
                users: { rule: "repeated", type: "ptt.User", id: 2 },
              },
            },
            QueryMembers: {
              fields: {
                gids: { rule: "repeated", type: "uint32", id: 1 },
                detail: { type: "int32", id: 2 },
                version2: { type: "bool", id: 3 },
                allowPage: { type: "bool", id: 4 },
              },
            },
            QueryMembersAck: {
              fields: {
                result: { type: "int32", id: 1 },
                members: { rule: "repeated", type: "ptt.GroupMembers", id: 2 },
              },
            },
            WatchGroup: {
              fields: {
                gid: { type: "uint32", id: 1 },
                uid: { type: "uint32", id: 2 },
                expectPt: { type: "uint32", id: 3 },
                acceptPt: { rule: "repeated", type: "uint32", id: 4 },
                store: { type: "bool", id: 5 },
              },
            },
            WatchGroupAck: {
              fields: {
                result: { type: "int32", id: 1 },
                gid: { type: "uint32", id: 2 },
                group: { type: "ptt.Group", id: 3 },
              },
            },
            ByeGroup: {
              fields: {
                gid: { type: "uint32", id: 1 },
                uid: { type: "uint32", id: 2 },
              },
            },
            RequestMic: {
              fields: {
                gid: { type: "uint32", id: 1 },
                uid: { type: "uint32", id: 2 },
                payload: { type: "uint32", id: 3 },
                sessionId: { type: "string", id: 4 },
                timestamp: { type: "uint32", id: 5 },
              },
            },
            RequestMicAck: {
              fields: {
                result: { type: "int32", id: 1 },
                gid: { type: "uint32", id: 2 },
                reason: { type: "int32", id: 3 },
                speechId: { type: "uint64", id: 4 },
              },
            },
            ReleaseMic: {
              fields: {
                gid: { type: "uint32", id: 1 },
                uid: { type: "uint32", id: 2 },
                timestamp: { type: "uint32", id: 3 },
                speechId: { type: "uint64", id: 4 },
              },
            },
            ReleaseMicAck: {
              fields: {
                result: { type: "int32", id: 1 },
                gid: { type: "uint32", id: 2 },
                speechId: { type: "uint64", id: 3 },
              },
            },
            LeaveGroup: { fields: { gid: { type: "uint32", id: 1 } } },
            LeaveGroupAck: {
              fields: {
                result: { type: "int32", id: 1 },
                gid: { type: "uint32", id: 2 },
              },
            },
          },
        },
        push: {
          nested: {
            UsersChanged: {
              fields: {
                users: { rule: "repeated", type: "ptt.User", id: 1 },
              },
            },
            CurrentGroup: {
              fields: {
                gid: { type: "uint32", id: 1 },
                reason: { type: "string", id: 2 },
                ip: { type: "uint32", id: 3 },
                port: { type: "uint32", id: 4 },
                gname: { type: "string", id: 5 },
                group: { type: "ptt.Group", id: 6 },
              },
            },
            MemberGetMic: {
              fields: {
                gid: { type: "uint32", id: 1 },
                uid: { type: "uint32", id: 2 },
                speechId: { type: "uint64", id: 4 },
              },
            },
            MemberLostMic: {
              fields: {
                gid: { type: "uint32", id: 1 },
                uid: { type: "uint32", id: 2 },
                speechId: { type: "uint64", id: 3 },
              },
            },
            LostMic: {
              fields: {
                gid: { type: "uint32", id: 1 },
                reason: { type: "string", id: 2 },
                reasoncode: { type: "int32", id: 3 },
                speechId: { type: "uint64", id: 4 },
              },
            },
          },
        },
        net: {
          nested: {
            HeartBeat: {
              fields: {
                timestamp: { type: "uint32", id: 1 },
                gid: { type: "uint32", id: 2 },
                uid: { type: "uint32", id: 3 },
                seq: { type: "uint32", id: 4 },
              },
            },
          },
        },
      },
    },
  },
});

function adler32(data: Uint8Array) {
  let a = 1;
  let b = 0;
  for (const byte of data) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

export function encodeMessage(name: string, value: Record<string, unknown> = {}) {
  const type = root.lookupType(name);
  return Buffer.from(type.encode(type.create(value)).finish());
}

export function decodeMessage(name: string, body: Uint8Array) {
  const type = root.lookupType(name);
  return type.toObject(type.decode(body), {
    longs: String,
    defaults: true,
  }) as Record<string, any>;
}

export function packControlFrame(name: string, value: Record<string, unknown> = {}) {
  const messageName = Buffer.from(`${name}\0`, "utf8");
  const body = encodeMessage(name, value);
  const packet = Buffer.allocUnsafe(4 + 2 + messageName.length + body.length + 4);
  packet.writeUInt32BE(packet.length - 4, 0);
  packet.writeUInt16BE(messageName.length, 4);
  messageName.copy(packet, 6);
  body.copy(packet, 6 + messageName.length);
  packet.writeUInt32BE(adler32(packet.subarray(0, -4)), packet.length - 4);
  return packet;
}

export function unpackControlFrame(packet: Buffer) {
  if (packet.length < 11 || packet.readUInt32BE(0) + 4 !== packet.length) {
    throw new Error("Invalid POCSTARS control frame length.");
  }
  // The installed server emits a four-byte vendor integrity trailer that is
  // not Adler-32 on replies, even though it accepts the legacy Adler-32 form
  // used by its client library. Frame boundaries are therefore enforced here
  // and the opaque reply trailer is excluded from protobuf decoding.
  const nameLength = packet.readUInt16BE(4);
  const nameEnd = 6 + nameLength;
  if (nameLength < 2 || nameEnd > packet.length - 4) {
    throw new Error("Invalid POCSTARS message name.");
  }
  const name = packet.subarray(6, nameEnd - 1).toString("utf8");
  const messageType = root.lookup(name);
  if (!(messageType instanceof Type)) {
    return {
      name,
      value: {},
      unknown: true,
    };
  }
  return {
    name,
    value: decodeMessage(name, packet.subarray(nameEnd, packet.length - 4)),
  };
}

export function packRtp(payloadType: number, sequence: number, timestamp: number, ssrc: number, payload: Uint8Array) {
  const packet = Buffer.allocUnsafe(12 + payload.length);
  packet[0] = 0x80;
  packet[1] = payloadType & 0x7f;
  packet.writeUInt16BE(sequence & 0xffff, 2);
  packet.writeUInt32BE(timestamp >>> 0, 4);
  packet.writeUInt32BE(ssrc >>> 0, 8);
  Buffer.from(payload).copy(packet, 12);
  return packet;
}

export function unpackRtp(packet: Buffer) {
  if (packet.length < 12 || packet[0] >> 6 !== 2) return null;
  const csrcCount = packet[0] & 0x0f;
  const hasExtension = Boolean(packet[0] & 0x10);
  let offset = 12 + csrcCount * 4;
  if (hasExtension) {
    if (packet.length < offset + 4) return null;
    offset += 4 + packet.readUInt16BE(offset + 2) * 4;
  }
  if (offset > packet.length) return null;
  return {
    payloadType: packet[1] & 0x7f,
    sequence: packet.readUInt16BE(2),
    timestamp: packet.readUInt32BE(4),
    ssrc: packet.readUInt32BE(8),
    payload: packet.subarray(offset),
  };
}

export function splitAmrFrames(input: Uint8Array) {
  let bytes = Buffer.from(input);
  if (bytes.subarray(0, 6).toString("ascii") === "#!AMR\n") bytes = bytes.subarray(6);
  const frameSizes = [13, 14, 16, 18, 20, 21, 27, 32, 6, 7, 6, 6];
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const frameType = (bytes[offset] >> 3) & 0x0f;
    const size = frameSizes[frameType];
    if (!size || offset + size > bytes.length) throw new Error("Invalid AMR-NB frame.");
    frames.push(bytes.subarray(offset, offset + size));
    offset += size;
  }
  return frames;
}
