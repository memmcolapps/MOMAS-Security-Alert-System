// Who may call whom between consoles. Agreed with the product owner:
//
//  - People in an organization call people in that same organization only.
//  - Platform staff can call anyone, in any organization.
//  - An organization can never call platform staff, and never another
//    organization.
//  - Viewers (the read-only org role) can answer a call but not start one.
//
// The server applies these on every call; the browser only uses them to decide
// which buttons to draw.

export type CallIdentity = {
  userId: number;
  platformStaff: boolean;
  // The organization this console is working in. Null for platform staff.
  activeOrganizationId: number | null;
  // Every organization the person belongs to - where they can be reached.
  organizationIds: number[];
  // False for viewers: they may answer but not start.
  mayStart: boolean;
};

/** Whether `caller` may reach `callee` at all, before role is considered. */
export function canReach(caller: CallIdentity, callee: CallIdentity) {
  if (caller.userId === callee.userId) return false;
  if (caller.platformStaff) return true;
  if (callee.platformStaff) return false;
  if (!caller.activeOrganizationId) return false;
  return callee.organizationIds.includes(caller.activeOrganizationId);
}

/** Whether `caller` may start a call to `callee`. */
export function canCall(caller: CallIdentity, callee: CallIdentity) {
  return caller.mayStart && canReach(caller, callee);
}

/**
 * The organization a call belongs to, for the call log: the caller's own
 * organization, or for platform staff the organization they called into.
 */
export function callOrganizationId(caller: CallIdentity, callee: CallIdentity) {
  if (!caller.platformStaff) return caller.activeOrganizationId;
  return callee.organizationIds[0] ?? null;
}
