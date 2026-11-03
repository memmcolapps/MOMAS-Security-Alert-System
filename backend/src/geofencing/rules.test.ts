import { describe, expect, test } from "bun:test";
import { classify, ruleMembers, signedDistanceMetres, step, zoneBounds, inBounds, type Membership } from "./rules";

// ~111 m per 0.001° of latitude.
const base = { shape_type: "circle" as const, center_lat: 9.0, center_lon: 7.0, radius_m: 500 };
const at = (metresNorth: number) => ({ lat: 9.0 + metresNorth / 111_320, lon: 7.0 });

function side(trigger: "exit" | "enter", metresNorth: number, buffer = 30) {
  const { lat, lon } = at(metresNorth);
  return classify(trigger, buffer, signedDistanceMetres(base, lat, lon)).side;
}

/** Runs a sequence of fixes through one rule and returns the events it raised. */
function run(trigger: "exit" | "enter", path: number[], confirmations = 3) {
  let state = null;
  const events: string[] = [];
  for (const metres of path) {
    const result = step(state, side(trigger, metres), confirmations);
    state = result.state;
    if (result.event) events.push(result.event);
  }
  return { events, state };
}

describe("rule sides", () => {
  test("exit rule: violating only past the drift allowance outside", () => {
    expect(side("exit", 0)).toBe("safe");
    expect(side("exit", 490)).toBe("safe");
    expect(side("exit", 515)).toBe("edge");
    expect(side("exit", 600)).toBe("violating");
  });

  test("enter rule: violating only past the drift allowance inside", () => {
    expect(side("enter", 2000)).toBe("safe");
    expect(side("enter", 510)).toBe("safe");
    expect(side("enter", 485)).toBe("edge");
    expect(side("enter", 300)).toBe("violating");
  });

  test("distance is measured in the direction that matters", () => {
    const outside = at(700);
    const inside = at(200);
    expect(classify("exit", 30, signedDistanceMetres(base, outside.lat, outside.lon)).distanceM).toBeCloseTo(200, -1);
    expect(classify("enter", 30, signedDistanceMetres(base, inside.lat, inside.lon)).distanceM).toBeCloseTo(300, -1);
  });
});

describe("rule state machine", () => {
  test("exit: alarms once after the required confirmations, then clears on return", () => {
    expect(run("exit", [0, 700, 700]).events).toEqual([]);
    expect(run("exit", [0, 700, 700, 700]).events).toEqual(["breach"]);
    expect(run("exit", [0, 700, 700, 700, 700, 700]).events).toEqual(["breach"]);
    expect(run("exit", [700, 700, 700, 100]).events).toEqual(["breach", "clear"]);
  });

  test("enter: alarms on going in, clears on leaving", () => {
    expect(run("enter", [2000, 200, 200, 200]).events).toEqual(["breach"]);
    expect(run("enter", [2000, 200, 200, 200, 2000]).events).toEqual(["breach", "clear"]);
  });

  test("a fix back towards the line resets a half-counted breach", () => {
    expect(run("exit", [700, 700, 100, 700, 700]).events).toEqual([]);
    expect(run("exit", [700, 700, 515, 700, 700]).events).toEqual([]);
  });

  test("a breached asset parked on the edge band does not flap", () => {
    // Out, confirmed, then jitter between the shape and the alarm line.
    expect(run("exit", [700, 700, 700, 515, 520, 512, 518]).events).toEqual(["breach"]);
    expect(run("exit", [700, 700, 700, 515, 520, 400]).events).toEqual(["breach", "clear"]);
  });

  test("one confirmation alarms on the first fix", () => {
    expect(run("enter", [200], 1).events).toEqual(["breach"]);
  });
});

describe("rule members", () => {
  const membership: Membership = {
    radioUnit: new Map([["r1", "10"], ["r2", "11"], ["r3", "12"], ["r4", null]]),
    droneUnit: new Map([["7", "11"]]),
    channelRadios: new Map([["5", ["r1", "r4"]]]),
    unitChildren: new Map([["10", ["11"]]]),
  };

  test("a unit covers its sub-units and their drones", () => {
    expect(ruleMembers({ target_type: "unit", target_id: "10" }, membership).sort()).toEqual(["drone:7", "radio:r1", "radio:r2"]);
    expect(ruleMembers({ target_type: "unit", target_id: "11" }, membership).sort()).toEqual(["drone:7", "radio:r2"]);
  });

  test("a channel covers the radios on it; a radio covers itself", () => {
    expect(ruleMembers({ target_type: "channel", target_id: "5" }, membership)).toEqual(["radio:r1", "radio:r4"]);
    expect(ruleMembers({ target_type: "radio", target_id: "r3" }, membership)).toEqual(["radio:r3"]);
  });
});

describe("zone bounds", () => {
  test("contain the zone plus margin and exclude far points", () => {
    const bounds = zoneBounds(base, 50);
    const near = at(540);
    const far = at(600);
    expect(inBounds(bounds, near.lat, near.lon)).toBe(true);
    expect(inBounds(bounds, far.lat, far.lon)).toBe(false);
  });
});
