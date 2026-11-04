import { useSearch } from "@tanstack/react-router";
import { OrganizationPage } from "../components/org/OrganizationPage";

// An organization admin's own organization. The same page a platform admin
// opens for it, minus the Platform tab.
export function OrgAdminRoute() {
  const { tab } = useSearch({ from: "/org/admin" });
  return <OrganizationPage tab={tab} basePath="/org/admin" />;
}
