import { describe, expect, test } from "bun:test";
import { allowsDeviceType, deviceTypeCondition, hasRadioNetwork, normalizeModules } from "./modules";

describe("Radio and Vehicle modules split the device estate", () => {
  test("no module list means everything is visible", () => {
    expect(deviceTypeCondition(undefined, "d.device_type")).toBeNull();
    expect(deviceTypeCondition([], "d.device_type")).toBeNull();
    expect(allowsDeviceType(undefined, "vehicle")).toBe(true);
  });

  test("both modules hide nothing", () => {
    expect(deviceTypeCondition(["radio", "vehicle"], "d.device_type")).toBeNull();
  });

  test("radio only hides vehicles but keeps untyped devices", () => {
    expect(deviceTypeCondition(["radio", "drone"], "d.device_type")).toBe("COALESCE(d.device_type, '') <> 'vehicle'");
    expect(allowsDeviceType(["radio"], "vehicle")).toBe(false);
    expect(allowsDeviceType(["radio"], "handheld")).toBe(true);
    expect(allowsDeviceType(["radio"], null)).toBe(true);
    expect(allowsDeviceType(["radio"], "fixed")).toBe(true);
  });

  test("vehicle only shows vehicles and nothing untyped", () => {
    expect(deviceTypeCondition(["vehicle"], "d.device_type")).toBe("d.device_type = 'vehicle'");
    expect(allowsDeviceType(["vehicle"], "vehicle")).toBe(true);
    expect(allowsDeviceType(["vehicle"], "handheld")).toBe(false);
    expect(allowsDeviceType(["vehicle"], null)).toBe(false);
  });

  test("neither module shows no devices at all", () => {
    expect(deviceTypeCondition(["drone", "osint"], "d.device_type")).toBe("FALSE");
    expect(allowsDeviceType(["drone"], "vehicle")).toBe(false);
    expect(allowsDeviceType(["drone"], "handheld")).toBe(false);
  });

  test("live audio is open to either module", () => {
    expect(hasRadioNetwork(["vehicle"])).toBe(true);
    expect(hasRadioNetwork(["radio"])).toBe(true);
    expect(hasRadioNetwork(["drone", "geofence"])).toBe(false);
    expect(hasRadioNetwork([])).toBe(true);
  });

  test("unknown module names are dropped", () => {
    expect(normalizeModules(["radio", "vehicle", "teleport", "radio"])).toEqual(["radio", "vehicle"]);
  });
});
