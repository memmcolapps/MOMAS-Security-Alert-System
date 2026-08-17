import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
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
import { PLATFORM_RANK, platformRank } from "./lib/platform-roles";
import { AlarmsRoute } from "./routes/AlarmsRoute";
import { AdminOrganizationDetailRoute } from "./routes/AdminOrganizationDetailRoute";
import { AdminOrganizationsRoute } from "./routes/AdminOrganizationsRoute";
import { PlatformStaffRoute } from "./routes/PlatformStaffRoute";
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
  const chromeRef = useRef(null);

  // The app chrome is two stacked fixed bars, and the radio bar's height
  // changes with its contents and wraps on narrow screens. Anything that has to
  // sit below the chrome - every overlay on the operations map - needs its real
  // height, not a guess. Publishing it as a variable is what stops those
  // overlays sliding underneath it.
  useEffect(() => {
    const node = chromeRef.current;
    const root = window.document.documentElement;
    if (!node) {
      root.style.setProperty("--ops-chrome", "0px");
      return undefined;
    }
    const observer = new window.ResizeObserver(([entry]) => {
      root.style.setProperty("--ops-chrome", `${Math.round(entry.contentRect.height)}px`);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [showHeader]);

  return (
    <LiveRadioProvider>
      <FollowProvider>
        {showHeader ? (
          <div ref={chromeRef} className="fixed left-0 right-0 top-0 z-[1100]">
            <AppHeader />
            <LiveRadioBar />
          </div>
        ) : null}
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

async function requirePlatform(minimum) {
  const session = await requireReadySession();
  if (platformRank(session.user) < PLATFORM_RANK[minimum]) throw redirect({ to: "/" });
  return session;
}

const requireAdmin = () => requirePlatform("support");
const requireOwner = () => requirePlatform("admin");

async function requireOrgAdmin() {
  const session = await requireReadySession();
  const role = session.user?.active_membership?.role || session.user?.memberships?.[0]?.role;
  if (!platformRank(session.user) && !["org_owner", "org_admin", "unit_admin", "admin"].includes(role)) {
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

const platformStaffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/team",
  beforeLoad: requireOwner,
  component: PlatformStaffRoute,
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
  platformStaffRoute,
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
