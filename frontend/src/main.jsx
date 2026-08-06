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
import { FollowBar } from "./components/FollowBar";
import { LiveRadioBar } from "./components/LiveRadioBar";
import { FollowProvider } from "./lib/follow-session";
import { LiveRadioProvider } from "./lib/live-radio-session";
import { getAuthToken, getMe } from "./lib/api";
import { AlarmsRoute } from "./routes/AlarmsRoute";
import { AdminOrganizationDetailRoute } from "./routes/AdminOrganizationDetailRoute";
import { AdminOrganizationsRoute } from "./routes/AdminOrganizationsRoute";
import { ChangePasswordRoute } from "./routes/ChangePasswordRoute";
import { DevicesRoute } from "./routes/DevicesRoute";
import { DronesRoute } from "./routes/DronesRoute";
import { GeofencesRoute } from "./routes/GeofencesRoute";
import { LoginRoute } from "./routes/LoginRoute";
import { OrgAdminRoute } from "./routes/OrgAdminRoute";
import { OperationsRoute } from "./routes/OperationsRoute";
import { OsintRoute } from "./routes/OsintRoute";
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
  const showHeader = !["/login", "/change-password"].includes(router.location.pathname);
  return (
    <LiveRadioProvider>
      <FollowProvider>
        {showHeader ? <AppHeader /> : null}
        {showHeader ? <LiveRadioBar /> : null}
        <Outlet />
        {/* Outlives any one page: a response runs while the operator moves
            between the map, the alarm and the radio console. */}
        {showHeader ? <FollowBar /> : null}
      </FollowProvider>
    </LiveRadioProvider>
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

async function requireReadySession() {
  const session = await requireSession();
  if (session.user?.must_change_password) throw redirect({ to: "/change-password" });
  return session;
}

async function requireAdmin() {
  const session = await requireReadySession();
  if (session.user?.platform_role !== "admin") throw redirect({ to: "/" });
  return session;
}

async function requireOrgAdmin() {
  const session = await requireReadySession();
  const role = session.user?.active_membership?.role || session.user?.memberships?.[0]?.role;
  if (session.user?.platform_role !== "admin" && !["org_owner", "org_admin", "unit_admin", "admin"].includes(role)) {
    throw redirect({ to: "/" });
  }
  return session;
}

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: requireReadySession,
  // `focus` carries an alarm key so the alarms screen can hand an alarm to the
  // operations map ("Show on operations map").
  validateSearch: (search) => (search.focus ? { focus: String(search.focus) } : {}),
  component: OperationsRoute,
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  beforeLoad: requireReadySession,
  component: DevicesRoute,
});

const alarmsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alarms",
  beforeLoad: requireReadySession,
  component: AlarmsRoute,
});

const dronesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drones",
  beforeLoad: requireReadySession,
  component: DronesRoute,
});

const geofencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/geofences",
  beforeLoad: requireReadySession,
  component: GeofencesRoute,
});

const osintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/osint",
  beforeLoad: requireReadySession,
  component: OsintRoute,
});

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/change-password",
  beforeLoad: requireSession,
  component: ChangePasswordRoute,
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
  alarmsRoute,
  devicesRoute,
  dronesRoute,
  geofencesRoute,
  osintRoute,
  loginRoute,
  changePasswordRoute,
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
