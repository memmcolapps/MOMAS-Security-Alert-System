import { describe, expect, test } from "bun:test";
import { pickGroupTargets } from "./group-call";

const radio = (device_id: string, organization_id: number | null, active = true) => ({
  device_id,
  organization_id,
  active,
  name: `R${device_id}`,
});

describe("pickGroupTargets", () => {
  const inScope = [radio("101", 1), radio("102", 1), radio("201", 2), radio("103", 1, false)];

  test("accepts radios from one organization", () => {
    const result = pickGroupTargets(inScope, ["101", "102", "101"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.devices.map((device) => device.device_id)).toEqual(["101", "102"]);
  });

  test("refuses a call that mixes organizations", () => {
    const result = pickGroupTargets(inScope, ["101", "201"]);
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("refuses a radio outside the operator's scope", () => {
    expect(pickGroupTargets(inScope, ["101", "999"])).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("refuses an inactive radio", () => {
    expect(pickGroupTargets(inScope, ["103"])).toMatchObject({ ok: false, code: "forbidden" });
  });

  test("refuses an empty or oversized call", () => {
    expect(pickGroupTargets(inScope, [])).toMatchObject({ ok: false });
    const many = Array.from({ length: 51 }, (_, index) => radio(String(1000 + index), 1));
    expect(pickGroupTargets(many, many.map((device) => device.device_id))).toMatchObject({ ok: false });
  });
});
