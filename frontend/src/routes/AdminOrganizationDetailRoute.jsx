import { useParams, useSearch } from "@tanstack/react-router";
import { OrganizationPage } from "../components/org/OrganizationPage";

// Any organization, as a platform admin sees it: exactly the page its own admins
// see, plus the Platform tab.
export function AdminOrganizationDetailRoute() {
  const { id } = useParams({ from: "/admin/organizations/$id" });
  const { tab } = useSearch({ from: "/admin/organizations/$id" });
  return <OrganizationPage orgId={Number(id)} tab={tab} basePath="/admin/organizations/$id" />;
}
