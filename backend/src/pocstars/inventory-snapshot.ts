// Shaping the vendor database's answer into the snapshot the registry sync
// consumes. Kept free of database and bridge imports so the contract between
// the two planes can be tested on its own: the sync is strict about this shape
// and wrong input fails quietly rather than loudly.

export type VendorGroup = {
  id: number | string;
  name?: string | null;
  type?: number | string | null;
};

export type VendorRadio = {
  uid: number | string;
  account?: string | null;
  name?: string | null;
  groupIds?: Array<number | string> | null;
};

export type CompanySnapshot = {
  // The vendor company these rows were read from. It is the only attribution a
  // radio in no group has, so it is carried through rather than inferred later.
  companyId?: number | string | null;
  groups?: VendorGroup[] | null;
  radios?: VendorRadio[] | null;
};

// A temporary call group, created by the network for a private call. The voice
// plane drops these and so must this one, or the registry fills with channels
// nobody created.
const TEMPORARY_GROUP_TYPE = 2;

// An IMEI is 14-16 digits; the install's handsets are almost all 15. Anything
// else in the account column belongs to an app user or to whatever a vendor
// engineer typed years ago, and is not an identifier for a physical radio.
function imeiFromAccount(account: unknown) {
  const trimmed = String(account ?? "").trim();
  return /^\d{14,16}$/.test(trimmed) ? trimmed : null;
}

function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function shapeDatabaseInventory(companySnapshots: CompanySnapshot[]) {
  const groups: Array<{ id: number; companyId: number | null; name: string; type: number }> = [];
  const radios = new Map<number, any>();
  const memberships: Array<{ groupId: number; radioId: number }> = [];
  const seenGroupIds = new Set<number>();

  for (const snapshot of companySnapshots) {
    const companyId = positiveInteger(snapshot.companyId);
    for (const group of snapshot.groups || []) {
      const id = positiveInteger(group.id);
      if (id === null || seenGroupIds.has(id)) continue;
      if (Number(group.type) === TEMPORARY_GROUP_TYPE) continue;
      seenGroupIds.add(id);
      groups.push({
        id,
        companyId,
        name: String(group.name || `Group ${id}`),
        type: Number(group.type || 0),
      });
    }

    for (const radio of snapshot.radios || []) {
      const uid = positiveInteger(radio.uid);
      if (uid === null) continue;
      radios.set(uid, {
        id: uid,
        companyId,
        // Handsets only: the query filters on user type, so no dispatcher
        // console can slip in the way it does through group membership.
        role: 0,
        departmentId: null,
        name: String(radio.name || radio.account || `Radio ${uid}`),
        // The vendor account is the IMEI printed on the handset, but only for a
        // handset: this install also carries 174 smartphone app accounts shaped
        // `pttN@REALM.TSY`, and writing one of those into the IMEI column would
        // make device search match on something no operator can read off any
        // hardware. Only a digit-shaped account is an IMEI.
        imei: imeiFromAccount(radio.account),
      });
      for (const groupId of radio.groupIds || []) {
        const id = positiveInteger(groupId);
        if (id !== null) memberships.push({ groupId: id, radioId: uid });
      }
    }
  }

  return { groups, radios: [...radios.values()], memberships };
}
