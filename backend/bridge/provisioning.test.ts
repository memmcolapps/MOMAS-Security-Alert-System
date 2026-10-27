import { describe, expect, test } from "bun:test";
import { PocstarsProvisioning } from "./provisioning";

// A fake vendor connection. mysql2 hands back `[rows, fields]`, and the code
// under test only ever reads the first element, so that is all this returns.
// Every statement is recorded so a test can assert on what the vendor database
// would actually have been asked to do.
function fakeVendor(rowsFor: (sql: string) => any) {
  const statements: string[] = [];
  let committed = false;
  let rolledBack = false;
  const connection = {
    beginTransaction: async () => {},
    query: async (sql: string, _args?: unknown[]) => {
      statements.push(sql.replace(/\s+/g, " ").trim());
      return [rowsFor(sql), []];
    },
    commit: async () => { committed = true; },
    rollback: async () => { rolledBack = true; },
    release: () => {},
  };
  const provisioning = new PocstarsProvisioning({
    host: "127.0.0.1", port: 3306, user: "test", password: "test", database: "test",
  });
  (provisioning as any).pool = { getConnection: async () => connection, end: async () => {} };
  return {
    provisioning,
    statements,
    get committed() { return committed; },
    get rolledBack() { return rolledBack; },
  };
}

const wrote = (statements: string[]) => statements.some((sql) => sql.startsWith("UPDATE"));

describe("retiring a radio", () => {
  test("retires a live radio and drops its group memberships", async () => {
    const vendor = fakeVendor((sql) =>
      sql.includes("SELECT") ? [{ User_ID: 1482, User_CompanyID: 13, IsActive: 1 }] : { affectedRows: 1 });

    const result = await vendor.provisioning.retireRadio({ uid: 1482, companyId: 13 });

    expect(result).toEqual({ uid: 1482, alreadyRetired: false, found: true });
    expect(vendor.statements.some((sql) => sql.includes("UPDATE tb_User"))).toBe(true);
    expect(vendor.statements.some((sql) => sql.includes("UPDATE tb_UserOfGroup"))).toBe(true);
    // Rule 1 of this file: a write echat cannot see is a write that did not
    // happen, so both timestamps have to move.
    const userWrite = vendor.statements.find((sql) => sql.includes("UPDATE tb_User "))!;
    expect(userWrite).toContain("User_UpdateTime = NOW()");
    expect(userWrite).toContain("Last_Update_Time = NOW()");
    expect(vendor.committed).toBe(true);
  });

  test("treats a radio the vendor already retired as retired", async () => {
    // The console retires on the network before deleting its own row, so a
    // failure here used to strand the MOMAS row permanently: the radio was
    // gone from the vendor, so the retire could never succeed, so the delete
    // could never run. This is the shape of a handset that re-registered under
    // a fresh uid, leaving the old one behind.
    const vendor = fakeVendor((sql) =>
      sql.includes("SELECT") ? [{ User_ID: 1482, User_CompanyID: 13, IsActive: 0 }] : { affectedRows: 0 });

    const result = await vendor.provisioning.retireRadio({ uid: 1482, companyId: 13 });

    expect(result).toEqual({ uid: 1482, alreadyRetired: true, found: true });
    expect(wrote(vendor.statements)).toBe(false);
  });

  test("treats a radio the vendor no longer has at all as retired", async () => {
    const vendor = fakeVendor((sql) => (sql.includes("SELECT") ? [] : { affectedRows: 0 }));

    const result = await vendor.provisioning.retireRadio({ uid: 9999, companyId: 13 });

    expect(result).toEqual({ uid: 9999, alreadyRetired: true, found: false });
    expect(wrote(vendor.statements)).toBe(false);
  });

  test("refuses a live radio that belongs to another organization", async () => {
    // The company scope is the tenant boundary. It must keep failing loudly:
    // reporting this one as "already retired" would let one organization
    // delete another's handset from its own console.
    const vendor = fakeVendor((sql) =>
      sql.includes("SELECT") ? [{ User_ID: 1482, User_CompanyID: 41, IsActive: 1 }] : { affectedRows: 1 });

    await expect(vendor.provisioning.retireRadio({ uid: 1482, companyId: 13 }))
      .rejects.toThrow("belongs to another organization");
    expect(wrote(vendor.statements)).toBe(false);
    expect(vendor.rolledBack).toBe(true);
  });

  test("retires without a company scope when the radio is in the pool", async () => {
    const vendor = fakeVendor((sql) =>
      sql.includes("SELECT") ? [{ User_ID: 1482, User_CompanyID: 13, IsActive: 1 }] : { affectedRows: 1 });

    const result = await vendor.provisioning.retireRadio({ uid: 1482, companyId: null });

    expect(result.alreadyRetired).toBe(false);
    expect(vendor.statements.some((sql) => sql.includes("UPDATE tb_User"))).toBe(true);
  });
});

describe("listInventory", () => {
  // Vendor rows for two companies, in the order MySQL would return them.
  const groupRows = [
    { companyId: 13, id: 1001, name: "EPAIL", type: 0 },
    { companyId: 95, id: 2001, name: "STEEL", type: 1 },
    { companyId: 13, id: 1002, name: "EPAIL OPS", type: 0 },
  ];
  const radioRows = [
    { companyId: 13, uid: 39, account: "359000000000039", name: "", enabled: 1, serviceEndsAt: null, groupIds: "1001,1002" },
    { companyId: 95, uid: 401, account: "359000000000401", name: "Steel 1", enabled: 0, serviceEndsAt: null, groupIds: "" },
    { companyId: 13, uid: 402, account: "359000000000402", name: "Ops 2", enabled: 1, serviceEndsAt: null, groupIds: "1002" },
  ];

  function vendorWith(queries: Array<{ sql: string; args: unknown[] }>) {
    const provisioning = new PocstarsProvisioning({
      host: "127.0.0.1", port: 3306, user: "test", password: "test", database: "test",
    });
    (provisioning as any).pool = {
      query: async (sql: string, args: unknown[] = []) => {
        queries.push({ sql, args });
        const companyIds = (args[0] as number[]) || [];
        const single = typeof args[0] === "number" ? [args[0]] : companyIds;
        if (sql.includes("FROM tb_ChatGroup")) {
          return [groupRows.filter((row) => single.includes(row.companyId))
            .map(({ companyId, ...rest }) => (sql.includes("Cg_ComID AS companyId") ? { companyId, ...rest } : rest)), []];
        }
        return [radioRows.filter((row) => single.includes(row.companyId))
          .map(({ companyId, ...rest }) => (sql.includes("User_CompanyID AS companyId") ? { companyId, ...rest } : rest)), []];
      },
      end: async () => {},
    };
    return provisioning;
  }

  test("returns exactly what the per-company reads return, for every company", async () => {
    const queries: Array<{ sql: string; args: unknown[] }> = [];
    const provisioning = vendorWith(queries);
    const bulk = await provisioning.listInventory([13, 95, 777]);
    for (const companyId of [13, 95, 777]) {
      expect(bulk.get(companyId)).toEqual({
        groups: await provisioning.listGroups(companyId),
        radios: await provisioning.listRadios(companyId),
      });
    }
    // Two queries for all three companies, each given the whole id list.
    const bulkQueries = queries.filter((query) => Array.isArray(query.args[0]));
    expect(bulkQueries).toHaveLength(2);
    expect(bulkQueries.every((query) => /IN \(\?\)/.test(query.sql))).toBe(true);
  });

  test("asks nothing when there are no companies", async () => {
    const queries: Array<{ sql: string; args: unknown[] }> = [];
    expect((await vendorWith(queries).listInventory([])).size).toBe(0);
    expect(queries).toHaveLength(0);
  });
});
