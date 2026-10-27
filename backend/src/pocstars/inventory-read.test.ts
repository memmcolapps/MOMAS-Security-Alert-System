import { describe, expect, test } from "bun:test";
import { readCompanySnapshots } from "./live-gateway";

// A stand-in for the bridge client: records every provisioning request and
// answers from a fixed vendor state, optionally as a bridge that predates the
// bulk command.
function fakeBridge({ bulk = true, failWith = null as string | null } = {}) {
  const calls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const client = {
    async provision(command: string, payload: any = {}) {
      calls.push(command);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      if (failWith) throw new Error(failWith);
      if (command === "provision.inventory") {
        if (!bulk) throw new Error("Unknown provisioning command provision.inventory.");
        return payload.companyIds.map((companyId: number) => ({
          companyId, groups: [{ id: companyId * 10 }], radios: [{ uid: companyId * 100 }],
        }));
      }
      if (command === "provision.groups") return [{ id: payload.companyId * 10 }];
      if (command === "provision.radios") return [{ uid: payload.companyId * 100 }];
      throw new Error(`unexpected ${command}`);
    },
  };
  return { client: client as any, calls, get peak() { return peak; } };
}

const companies = Array.from({ length: 20 }, (_, i) => i + 1);
const expected = companies.map((companyId) => ({
  companyId, groups: [{ id: companyId * 10 }], radios: [{ uid: companyId * 100 }],
}));

describe("readCompanySnapshots", () => {
  test("asks a current bridge once for every company", async () => {
    const bridge = fakeBridge();
    expect(await readCompanySnapshots(bridge.client, companies)).toEqual(expected);
    expect(bridge.calls).toEqual(["provision.inventory"]);
  });

  test("falls back to per-company requests on an older bridge, in order and a few at a time", async () => {
    const bridge = fakeBridge({ bulk: false });
    expect(await readCompanySnapshots(bridge.client, companies)).toEqual(expected);
    expect(bridge.calls.filter((call) => call === "provision.groups")).toHaveLength(20);
    expect(bridge.calls.filter((call) => call === "provision.radios")).toHaveLength(20);
    // Six companies at a time, two requests each.
    expect(bridge.peak).toBeLessThanOrEqual(12);
    expect(bridge.peak).toBeGreaterThan(2);
  });

  test("a real failure is not mistaken for an older bridge", async () => {
    const bridge = fakeBridge({ failWith: "Provisioning is not enabled on this bridge." });
    await expect(readCompanySnapshots(bridge.client, companies)).rejects.toThrow("not enabled");
    expect(bridge.calls).toEqual(["provision.inventory"]);
  });
});
