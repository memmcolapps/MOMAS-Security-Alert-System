import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppHeader } from "./components/AppHeader";
import { getAuthToken, getMe } from "./lib/api";
import { AdminOrganizationDetailRoute } from "./routes/AdminOrganizationDetailRoute";
import { AdminOrganizationsRoute } from "./routes/AdminOrganizationsRoute";
import { DevicesRoute } from "./routes/DevicesRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { OrgAdminRoute } from "./routes/OrgAdminRoute";
import { OperationsRoute } from "./routes/OperationsRoute";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function RootLayout() {
  const router = useRouterState();
  const showHeader = router.location.pathname !== "/login";
  return (
    <>
      {showHeader ? <AppHeader /> : null}
      <Outlet />
    </>
  );
}

function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-ops-bg p-6 text-neutral-200">
      <div className="glass-panel max-w-sm rounded-lg p-6 text-center">
        <h1 className="text-lg font-bold text-ops-red">Page not found</h1>
        <p className="mt-2 text-xs text-neutral-500">
          This view is not registered in the operations console.
        </p>
        <Link
          to="/"
          className="mt-5 inline-flex rounded-md border border-ops-line px-4 py-2 text-xs font-bold text-ops-red hover:bg-red-500/10"
        >
          Back to map
        </Link>
      </div>
    </main>
  );
}

const rootRoute = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFound,
});

async function requireSession() {
  if (!getAuthToken()) throw redirect({ to: "/login" });
  try {
    return await queryClient.fetchQuery({
      queryKey: ["me"],
      queryFn: getMe,
      staleTime: 60_000,
    });
  } catch {
    throw redirect({ to: "/login" });
  }
}

async function requireAdmin() {
  const session = await requireSession();
  if (session.user?.platform_role !== "admin") throw redirect({ to: "/" });
  return session;
}

async function requireOrgAdmin() {
  const session = await requireSession();
  const role = session.user?.memberships?.[0]?.role;
  if (session.user?.platform_role !== "admin" && !["org_owner", "org_admin", "unit_admin", "admin"].includes(role)) {
    throw redirect({ to: "/" });
  }
  return session;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireSession,
  component: OperationsRoute,
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  beforeLoad: requireSession,
  component: DevicesRoute,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: LoginRoute,
});

const adminOrganizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/organizations",
  beforeLoad: requireAdmin,
  component: AdminOrganizationsRoute,
});

const adminOrganizationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/organizations/$id",
  beforeLoad: requireAdmin,
  component: AdminOrganizationDetailRoute,
});

const orgAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/org/admin",
  beforeLoad: requireOrgAdmin,
  component: OrgAdminRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  devicesRoute,
  loginRoute,
  adminOrganizationsRoute,
  adminOrganizationDetailRoute,
  orgAdminRoute,
]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>,
);
