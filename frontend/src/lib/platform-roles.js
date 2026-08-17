// Mirrors PLATFORM_RANK in backend/src/auth.ts.
//
// The server decides every request; this exists so the UI can offer the right
// screens and controls rather than letting somebody click into a 403. Keep the
// two in step - a tier added here that the backend does not know becomes rank 0
// there, which fails closed.
export const PLATFORM_RANK = { none: 0, support: 1, ops: 2, admin: 3 };

export const PLATFORM_ROLE_LABELS = {
  support: "Support",
  ops: "Operations",
  admin: "Platform owner",
};

export function platformRank(user) {
  return PLATFORM_RANK[user?.platform_role] ?? 0;
}

/** Any tier above a tenant user: sees across organizations. */
export function isPlatformStaff(user) {
  return platformRank(user) > 0;
}

/** May change the estate. Support cannot. */
export function isPlatformOperator(user) {
  return platformRank(user) >= PLATFORM_RANK.ops;
}

/** May manage the platform team, delete a company, change seats. */
export function isPlatformOwner(user) {
  return platformRank(user) >= PLATFORM_RANK.admin;
}
