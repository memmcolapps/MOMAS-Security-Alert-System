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
