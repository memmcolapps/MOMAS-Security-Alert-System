import { describe, expect, test } from "bun:test";
import { shapeDatabaseInventory } from "./inventory-snapshot";

describe("database inventory snapshot", () => {
  test("keeps handsets that belong to no group at all", () => {
    // The whole point of reading the vendor database: the voice plane can only
    // enumerate radios through group membership, so these were invisible.
    const snapshot = shapeDatabaseInventory([
      {
        groups: [{ id: 10, name: "EPAIL", type: 1 }],
        radios: [
          { uid: 100, name: "Radio A", groupIds: [10] },
          { uid: 101, name: "Radio B", groupIds: [] },
          { uid: 102, account: "epail103", groupIds: null },
        ],
      },
    ]);
    expect(snapshot.radios.map((radio) => radio.id)).toEqual([100, 101, 102]);
    expect(snapshot.memberships).toEqual([{ groupId: 10, radioId: 100 }]);
  });

  test("names a radio from its account when the vendor left the name blank", () => {
    const snapshot = shapeDatabaseInventory([
      { radios: [{ uid: 7, account: "zamf007", name: "" }, { uid: 8 }] },
    ]);
    expect(snapshot.radios[0].name).toBe("zamf007");
    expect(snapshot.radios[1].name).toBe("Radio 8");
  });

  test("refuses to file an app account as an IMEI", () => {
    // 174 of this install's 726 radios are smartphone app users shaped
    // pttN@REALM.TSY, and NCS's whole fleet is one. An IMEI is what an operator
    // reads off a handset, so an app account must leave the column empty rather
    // than fill it with something no hardware carries.
    const snapshot = shapeDatabaseInventory([
      {
        radios: [
          { uid: 200, account: "867539051234567", name: "Handset" },
          { uid: 201, account: "ptt1@NCS.TSY", name: "App user" },
          { uid: 202, account: "epail103", name: "Legacy" },
        ],
      },
    ]);
    expect(snapshot.radios[0].imei).toBe("867539051234567");
    expect(snapshot.radios[1].imei).toBeNull();
    expect(snapshot.radios[2].imei).toBeNull();
    // The radio itself is still inventoried; only its IMEI is unknown.
    expect(snapshot.radios.map((radio) => radio.id)).toEqual([200, 201, 202]);
  });

  test("carries the vendor account through as the IMEI so device search matches it", () => {
    const snapshot = shapeDatabaseInventory([
      { radios: [{ uid: 100, account: "352000123456789", name: "Radio A" }, { uid: 101, name: "Radio B" }] },
    ]);
    expect(snapshot.radios[0].imei).toBe("352000123456789");
    expect(snapshot.radios[1].imei).toBeNull();
  });

  test("drops temporary call groups but keeps their radios", () => {
    const snapshot = shapeDatabaseInventory([
      {
        groups: [
          { id: 10, name: "EPAIL", type: 1 },
          { id: 11, name: "Private call 4471", type: 2 },
        ],
        radios: [{ uid: 100, name: "Radio A", groupIds: [10, 11] }],
      },
    ]);
    expect(snapshot.groups.map((group) => group.id)).toEqual([10]);
    expect(snapshot.radios).toHaveLength(1);
  });

  test("merges companies without duplicating a radio or a group", () => {
    const snapshot = shapeDatabaseInventory([
      { groups: [{ id: 10, name: "EPAIL", type: 1 }], radios: [{ uid: 100, name: "Radio A", groupIds: [10] }] },
      { groups: [{ id: 10, name: "EPAIL", type: 1 }, { id: 20, name: "ZAMF_SEC", type: 1 }], radios: [{ uid: 100, name: "Radio A", groupIds: [10] }, { uid: 200, name: "Radio C", groupIds: [20] }] },
    ]);
    expect(snapshot.groups.map((group) => group.id)).toEqual([10, 20]);
    expect(snapshot.radios.map((radio) => radio.id)).toEqual([100, 200]);
  });

  test("reports every radio as a handset, never as a dispatcher console", () => {
    // syncPocstarsPlatformInventory skips role 3 as a console. The database
    // query already excludes seats, so nothing here may claim that role.
    const snapshot = shapeDatabaseInventory([
      { radios: [{ uid: 100, name: "Radio A" }, { uid: 583, name: "Dispatcher" }] },
    ]);
    expect(snapshot.radios.every((radio) => radio.role === 0)).toBe(true);
  });

  test("discards unusable ids rather than writing them to the registry", () => {
    const snapshot = shapeDatabaseInventory([
      {
        groups: [{ id: 0, name: "Nowhere" }, { id: "abc" as any, name: "Nonsense" }],
        radios: [{ uid: -1 }, { uid: "" as any }, { uid: 100, groupIds: [0, "x" as any, 10] }],
      },
    ]);
    expect(snapshot.groups).toEqual([]);
    expect(snapshot.radios.map((radio) => radio.id)).toEqual([100]);
    expect(snapshot.memberships).toEqual([{ groupId: 10, radioId: 100 }]);
  });

  test("carries no presence, so nothing can be mistaken for an online radio", () => {
    const snapshot = shapeDatabaseInventory([{ radios: [{ uid: 100, name: "Radio A" }] }]);
    expect(snapshot.radios[0]).not.toHaveProperty("online");
  });
});
