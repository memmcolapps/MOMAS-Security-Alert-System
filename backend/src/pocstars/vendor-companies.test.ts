import { describe, expect, test } from "bun:test";
import {
  isReadOnlyProvisionCommand,
  refuseDiscoveredWrite,
  shapeVendorCompanies,
  slugForCompany,
} from "./vendor-companies";

describe("vendor company slugs", () => {
  test("derives a readable slug from the vendor's company name", () => {
    expect(slugForCompany("EPAIL Security Services", 13, new Set())).toBe("epail-security-services");
  });

  test("falls back to the company id, not a counter, when the name is taken", () => {
    // Stability is the point: a counter would hand the same company a different
    // slug the moment another company was created before it.
    const taken = new Set(["epail"]);
    expect(slugForCompany("EPAIL", 13, taken)).toBe("epail-13");
    expect(slugForCompany("EPAIL", 13, new Set(["epail"]))).toBe("epail-13");
  });

  test("survives a name that leaves nothing behind", () => {
    // Vendor names are free text typed years ago. A name written in a script
    // with no Latin characters, or left blank, must still produce a usable slug
    // rather than abort the whole import.
    expect(slugForCompany("保安公司", 41, new Set())).toBe("company-41");
    expect(slugForCompany("", 42, new Set())).toBe("company-42");
    expect(slugForCompany("   ", 43, new Set())).toBe("company-43");
  });

  test("strips accents rather than dropping the whole word", () => {
    expect(slugForCompany("Sécurité Générale", 9, new Set())).toBe("securite-generale");
  });

  test("never ends a slug on a hyphen after truncation", () => {
    const slug = slugForCompany(`${"a".repeat(39)} bravo`, 5, new Set());
    expect(slug.endsWith("-")).toBe(false);
    expect(slug.length).toBeLessThanOrEqual(40);
  });
});

describe("shaping vendor companies into organizations", () => {
  test("never lands the unallocated pool as an organization", () => {
    // An owner is exactly what a pooled radio does not have. Import the pool as
    // an organization and every unallocated handset acquires one.
    const shaped = shapeVendorCompanies([
      { companyId: 13, name: "EPAIL", seats: 3, radios: 76 },
      { companyId: 99, name: "MOMAS UNALLOCATED POOL", seats: 0, radios: 12, isPool: true },
    ]);
    expect(shaped.map((company) => company.companyId)).toEqual([13]);
  });

  test("skips an active company holding neither a radio nor a seat", () => {
    // 40 of this install's 76 active companies are empty org-chart fragments
    // and vendor junk. Importing them buries the handful that matter.
    const shaped = shapeVendorCompanies([
      { companyId: 101, name: "NISO", radios: 206, seats: 1 },
      { companyId: 109, name: "Zamfara", radios: 0, seats: 6 },
      { companyId: 51, name: "ACP01", radios: 0, seats: 0 },
      { companyId: 12, name: "ceshi", radios: 0, seats: 0 },
    ]);
    expect(shaped.map((company) => company.companyId)).toEqual([101, 109]);
  });

  test("two companies in one sync cannot be handed the same slug", () => {
    const shaped = shapeVendorCompanies([
      { companyId: 20, name: "Falcon", seats: 1, radios: 1 },
      { companyId: 21, name: "Falcon", seats: 1, radios: 1 },
    ]);
    expect(shaped.map((company) => company.slug)).toEqual(["falcon", "falcon-21"]);
  });

  test("respects slugs organizations already hold", () => {
    const shaped = shapeVendorCompanies(
      [{ companyId: 13, name: "EPAIL", seats: 2, radios: 79 }],
      new Set(["epail"]),
    );
    expect(shaped[0].slug).toBe("epail-13");
  });

  test("sizes from leasable seats but judges emptiness on dispatcher rows", () => {
    // NCS on the live install has three dispatcher rows and zero leasable
    // seats: one is MOMAS's reserved presence account and the rest have expired
    // service dates. It is plainly a real company, so it must be imported - but
    // sized as though it had none, because echat refuses to sign those in.
    const shaped = shapeVendorCompanies([
      { companyId: 14, name: "NCS", radios: 92, seats: 0, seatRows: 3 },
      { companyId: 60, name: "Lapsed", radios: 0, seats: 0, seatRows: 2 },
      { companyId: 61, name: "Hollow", radios: 0, seats: 0, seatRows: 0 },
    ]);
    expect(shaped.map((company) => company.companyId)).toEqual([14, 60]);
    expect(shaped[0].radioSeats).toBe(2);
  });

  test("sizes seats from what the company has, not from its size cap", () => {
    // Dis_Size is an administrative number the vendor console writes and is
    // routinely larger than the seats that actually exist.
    const shaped = shapeVendorCompanies([
      { companyId: 30, name: "Kite", seats: 3, seatCap: 25, radios: 4 },
      { companyId: 31, name: "Heron", seats: 0, seatCap: 10, radios: 4 },
    ]);
    expect(shaped[0].radioSeats).toBe(3);
    expect(shaped[1].radioSeats).toBe(2);
  });

  test("reserves no platform seats inside a company we do not operate", () => {
    const shaped = shapeVendorCompanies([{ companyId: 30, name: "Kite", seats: 3, radios: 4 }]);
    expect(shaped[0].platformRadioSeats).toBe(0);
  });

  test("drops rows the vendor cannot identify, and keeps the rest", () => {
    const shaped = shapeVendorCompanies([
      { companyId: 0, name: "Broken", radios: 1 },
      { companyId: "not a number", name: "Also broken", radios: 1 },
      { companyId: 44, name: "Real", radios: 1 },
      { companyId: 44, name: "Duplicate", radios: 1 },
    ]);
    expect(shaped.map((company) => company.companyId)).toEqual([44]);
    expect(shaped[0].name).toBe("Real");
  });
});

describe("keeping MOMAS out of a company it has not taken on", () => {
  const discovered = { name: "NISO", status: "discovered" };
  const operated = { name: "EPAIL NIGERIA", status: "active" };

  test("refuses every mutating command against a discovered company", () => {
    // Not an enumeration of today's commands: anything outside the read-only
    // set is refused, so a provisioning command added later is guarded by
    // default rather than by somebody remembering to add it here.
    for (const command of [
      "provision.channel.create",
      "provision.channel.retire",
      "provision.radio.create",
      "provision.radio.reassign",
      "provision.radio.retire",
      "provision.seat.renew",
      "provision.seats.add",
      "provision.something.invented.tomorrow",
    ]) {
      expect(refuseDiscoveredWrite(command, discovered)).toMatch(/NISO.*not operated by MOMAS yet/s);
    }
  });

  test("still allows reads - seeing the whole estate is the point of the import", () => {
    for (const command of [
      "provision.ping",
      "provision.radios",
      "provision.groups",
      "provision.seats",
      "provision.companies",
      "provision.company.forGroup",
    ]) {
      expect(isReadOnlyProvisionCommand(command)).toBe(true);
      expect(refuseDiscoveredWrite(command, discovered)).toBeNull();
    }
  });

  test("leaves an organization MOMAS operates alone", () => {
    expect(refuseDiscoveredWrite("provision.channel.create", operated)).toBeNull();
  });

  test("does not block a company with no organization behind it", () => {
    // The unallocated pool is not a tenant and has to stay writable, or
    // allocating a radio to anybody would be impossible.
    expect(refuseDiscoveredWrite("provision.radio.create", null)).toBeNull();
    expect(refuseDiscoveredWrite("provision.radio.create", undefined)).toBeNull();
  });
});
