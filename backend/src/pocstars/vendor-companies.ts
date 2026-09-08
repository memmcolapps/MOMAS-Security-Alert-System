// Turning the vendor's company list into organizations MOMAS can hold. Kept
// free of database and bridge imports for the same reason as the inventory
// snapshot: the surprises all live in the shaping - a vendor company name is
// free text typed by whoever set the company up years ago - and that deserves
// to be testable without either plane running.

export type VendorCompany = {
  companyId: number | string;
  name?: string | null;
  parentId?: number | string | null;
  seatCap?: number | string | null;
  radios?: number | string | null;
  seats?: number | string | null;
  isPool?: boolean;
};

// What an imported organization gets when the vendor company has no usable
// dispatcher seat of its own. Two is the same default a hand-created
// organization gets, so an import is never quietly stingier than the form.
export const DEFAULT_TENANT_SEATS = 2;

// Deliberately zero for an imported organization. Reserving a platform seat
// inside a company we do not operate spends capacity belonging to somebody
// else's control room, and it is one number to raise at promotion time once
// somebody has decided we are entitled to listen.
export const IMPORTED_PLATFORM_SEATS = 0;

const MAX_SLUG_LENGTH = 40;

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

// A vendor name is not a slug and cannot be trusted to become one: it may be
// blank, duplicated across two companies, or written in a script that leaves
// nothing behind once non-alphanumerics are stripped. Every one of those has to
// produce a usable slug rather than abort the sync, because a single unslugable
// company would otherwise cost us the whole import.
export function slugForCompany(name: string | null | undefined, companyId: number, taken: Set<string>) {
  const base = String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  // The company id is the fallback rather than a counter, so a company that
  // needs one keeps the same slug on every later sync. A counter would hand the
  // same company a different slug the moment another company was created.
  const candidates = base
    ? [base, `${base}-${companyId}`]
    : [`company-${companyId}`];

  for (const candidate of candidates) {
    if (!taken.has(candidate)) return candidate;
  }

  // Both stable forms are spoken for - two vendor companies sharing a name is
  // ordinary, the same name twice with the same id is not - so this is close to
  // unreachable. It still has to terminate somewhere.
  const stem = candidates[candidates.length - 1];
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`No free slug could be derived for company ${companyId}.`);
}

export type ShapedCompany = {
  companyId: number;
  name: string;
  parentId: number | null;
  slug: string;
  radios: number;
  radioSeats: number;
  platformRadioSeats: number;
};

// `taken` carries the slugs already in use by existing organizations. It is
// mutated as companies are shaped so that two new companies in the same sync
// cannot be handed the same slug.
export function shapeVendorCompanies(companies: VendorCompany[], taken: Set<string> = new Set()) {
  const shaped: ShapedCompany[] = [];
  const seen = new Set<number>();

  for (const company of companies || []) {
    const companyId = positiveInteger(company.companyId);
    if (companyId === null || seen.has(companyId)) continue;
    // The pool is enumerated by the inventory sync but is not an organization,
    // and neither is anything the bridge flags the same way later.
    if (company.isPool) continue;

    // An active company holding neither a radio nor a seat is not an
    // organization anybody operates. This install has 76 active companies but
    // only 36 with anything in them; the other 40 are org-chart fragments
    // (ACP01, DCP04, DSP03) and vendor junk (test, ceshi, tttt, whx). Importing
    // them would bury the six organizations that matter in a list of empties.
    // Flip this one condition if an empty company should still appear.
    const radios = Math.max(0, Number(company.radios || 0));
    const seats = Number(company.seats || 0);
    if (!radios && !seats) continue;

    seen.add(companyId);

    const name = String(company.name || "").trim() || `Company ${companyId}`;
    const slug = slugForCompany(name, companyId, taken);
    taken.add(slug);

    // Prefer what the company actually has over what its size cap says it may
    // have: the cap is an administrative number the vendor console writes and
    // is routinely larger than the seats that exist.
    shaped.push({
      companyId,
      name,
      parentId: positiveInteger(company.parentId),
      slug,
      radios,
      radioSeats: Math.max(1, Math.min(50, seats || DEFAULT_TENANT_SEATS)),
      platformRadioSeats: IMPORTED_PLATFORM_SEATS,
    });
  }

  return shaped;
}

// ── Discovered organizations ─────────────────────────────────────────────────
// A company the sync found and landed as an organization, which is not the same
// as one MOMAS operates. Reading the whole estate is the point of the import;
// acting on a tenant nobody has taken responsibility for is not.

export const DISCOVERED_STATUS = "discovered";

// Commands that only read the vendor database. Everything outside this set
// changes a company on an install MOMAS shares with other operators.
const READ_ONLY_PROVISION_COMMANDS = new Set([
  "provision.ping",
  "provision.seats",
  "provision.groups",
  "provision.radios",
  "provision.companies",
  "provision.company.forGroup",
]);

export function isReadOnlyProvisionCommand(command: string) {
  return READ_ONLY_PROVISION_COMMANDS.has(String(command));
}

// The refusal message, or null when the command may proceed. Written as a
// decision over plain values rather than a lookup so it can be tested without
// a database, and so the allow-list lives beside the shaping it belongs with.
//
// A company with no organization behind it - the unallocated pool, or one this
// install carries that MOMAS never imported - is left alone: it is not a
// tenant, and the pool in particular must stay writable for allocation.
export function refuseDiscoveredWrite(
  command: string,
  organization: { name?: string | null; status?: string | null } | null | undefined,
) {
  if (isReadOnlyProvisionCommand(command)) return null;
  if (!organization || String(organization.status || "") !== DISCOVERED_STATUS) return null;
  return `${organization.name || "That organization"} was discovered on the radio network and is `
    + "not operated by MOMAS yet. Promote it before changing anything on its radio network.";
}
