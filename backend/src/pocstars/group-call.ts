// A quick group call pulls every radio in at once, so each one is checked the
// way a private call checks its single target - in one registry read rather
// than one per radio. Channels never mix organizations, and neither may a group
// call: it would put another tenant's radios on our console's audio.
const MAX_GROUP_CALL_RADIOS = 50;

// devices is everything in the operator's scope, so a radio missing from it is
// one they may not call.
export function pickGroupTargets(devices: any[], deviceIds: unknown[]) {
  const wanted = [...new Set(deviceIds.map(String).filter(Boolean))];
  if (!wanted.length) {
    return { ok: false as const, code: "invalid_radio_uid", message: "Pick at least one radio for the group call." };
  }
  if (wanted.length > MAX_GROUP_CALL_RADIOS) {
    return {
      ok: false as const,
      code: "invalid_radio_uid",
      message: `A group call can include at most ${MAX_GROUP_CALL_RADIOS} radios.`,
    };
  }
  const byId = new Map(devices.map((device: any) => [String(device.device_id), device]));
  const targets: any[] = [];
  for (const deviceId of wanted) {
    const device = byId.get(deviceId);
    if (!device || !device.active) {
      return {
        ok: false as const,
        code: "forbidden",
        message: `${device?.name || `Radio ${deviceId}`} is not an active radio in your operational scope.`,
      };
    }
    const uid = Number(device.device_id);
    if (!Number.isSafeInteger(uid) || uid <= 0) {
      return { ok: false as const, code: "invalid_radio_uid", message: `${device.name || deviceId} has no valid radio ID.` };
    }
    targets.push(device);
  }
  const organizations = new Set(targets.map((device) => String(device.organization_id ?? "")));
  if (organizations.size > 1) {
    return {
      ok: false as const,
      code: "forbidden",
      message: "A group call can only include radios from one organization.",
    };
  }
  return { ok: true as const, devices: targets };
}
