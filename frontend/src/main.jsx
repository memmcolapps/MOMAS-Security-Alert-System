import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import {
  Link,
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  redirect,
  useRouterState,
} from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { AppHeader } from "./components/AppHeader";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { FollowBar } from "./components/FollowBar";
import { LiveRadioBar } from "./components/LiveRadioBar";
import { SosAlarmBanner, SosAlarmProvider } from "./components/SosAlarm";
import { FollowProvider } from "./lib/follow-session";
import { LiveRadioProvider } from "./lib/live-radio-session";
import { CallsProvider } from "./lib/console-calls";
import { CallOverlays, CallStrip } from "./components/calls/CallOverlays";
import { getActiveOrganizationId, getAuthToken, getMe } from "./lib/api";
import { noteRestoredAt } from "./lib/connection";
import { persistQueryCache, restoreQueryCache } from "./lib/offline-cache";
import { MODULES, hasRadioNetwork, moduleSet } from "./lib/modules";
import { PLATFORM_RANK, platformRank } from "./lib/platform-roles";
import { registerServiceWorker } from "./lib/service-worker";
import "./styles.css";

// Each screen is its own chunk, fetched on first visit (or on hover, through
// defaultPreload: "intent"), so the login page and the map do not pay for the
// OSINT graph, the geofence editor and the admin consoles up front.
const page = (name) => lazyRouteComponent(() => import(`./routes/${name}.jsx`), name);

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
    // By default a change made offline is held and sent when the network
    // returns. Here that could acknowledge an alarm someone else has already
    // handled, so it fails at once with "You're offline. Nothing was saved."
    mutations: { networkMode: "always" },
  },
});

const currentSession = () => ({ token: getAuthToken(), organizationId: getActiveOrganizationId() });

function RootLayout() {
  const router = useRouterState();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const showHeader = !["/login", "/change-password"].includes(router.location.pathname);
  // Read on every render (each navigation re-renders this), so signing in again
  // or switching organization reconnects calls under the new identity.
  const session = currentSession();
  const me = meQuery.data?.user;
  const activeMembership = me?.memberships?.find((membership) => Number(membership.organization_id) === Number(getActiveOrganizationId())) || me?.memberships?.[0];
  const showRadio = Boolean(platformRank(me) || hasRadioNetwork(moduleSet(activeMembership?.modules)));
  const chromeRef = useRef(null);

  // The app chrome is the header plus a radio strip that only shows while the
  // radio is live, and wraps on narrow screens. Anything that has to
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
      <CallsProvider enabled={showHeader && Boolean(session.token)} sessionKey={`${session.token}:${session.organizationId}`}>
      <FollowProvider>
        <SosAlarmProvider enabled={showHeader && showRadio}>
          {showHeader ? (
            <div ref={chromeRef} className="fixed left-0 right-0 top-0 z-[1100]">
              <AppHeader />
              {showRadio ? <LiveRadioBar /> : null}
              <CallStrip />
              <ConnectionBanner />
            </div>
          ) : null}
          <Outlet />
          {/* Outlives any one page: a response runs while the operator moves
              between the map, the alarm and the radio console. */}
          {showHeader && showRadio ? <FollowBar /> : null}
          {showHeader && showRadio ? <SosAlarmBanner /> : null}
          {showHeader ? <CallOverlays /> : null}
        </SosAlarmProvider>
      </FollowProvider>
      </CallsProvider>
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
  // The saved copy restored at startup belongs to this same sign-in, so the
  // page can open on it at once - with no network, or a server slow to answer -
  // while the check runs behind. A server that says the session is over still
  // ends it.
  // An invalidated copy is skipped: a password change marks it so the next
  // page sees the cleared must_change_password flag.
  const cached = queryClient.getQueryData(["me"]);
  if (cached && !queryClient.getQueryState(["me"])?.isInvalidated) {
    queryClient.fetchQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 }).catch((error) => {
      if (error?.status === 401) router.navigate({ to: "/login" });
    });
    return cached;
  }
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

const enabledModules = (session) => {
  if (platformRank(session.user)) return new Set(MODULES);
  const membership = session.user?.active_membership || session.user?.memberships?.find(
    (item) => Number(item.organization_id) === Number(getActiveOrganizationId()),
  ) || session.user?.memberships?.[0];
  return moduleSet(membership?.modules);
};

// Takes one module or a list, any of which opens the page.
function requireModule(module) {
  const wanted = Array.isArray(module) ? module : [module];
  return async () => {
    const session = await requireReadySession();
    const modules = enabledModules(session);
    if (wanted.some((name) => modules.has(name))) return session;
    const fallback = MODULES.find((candidate) => modules.has(candidate));
    throw redirect({ to: fallback === "drone" ? "/drones" : fallback === "geofence" ? "/geofences" : "/" });
  };
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
  // The map can show any combination of enabled modules, including a drone
  // or OSINT-only tenant with no radio access.
  beforeLoad: requireReadySession,
  // `focus` carries an alarm key so the alarms screen can hand an alarm to the
  // operations map ("Show on operations map").
  // `track` lists the tracked radios, so a refresh keeps the split screen.
  validateSearch: (search) => ({
    ...(search.focus ? { focus: String(search.focus) } : {}),
    ...(search.track ? { track: String(search.track) } : {}),
  }),
  component: page("OperationsRoute"),
});

const replayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/replay",
  beforeLoad: requireModule(["radio", "vehicle"]),
  component: page("ReplayRoute"),
});

const devicesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/devices",
  beforeLoad: requireModule(["radio", "vehicle"]),
  component: page("DevicesRoute"),
});

const alarmsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/alarms",
  beforeLoad: requireModule(["radio", "vehicle"]),
  component: page("AlarmsRoute"),
});

const dronesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/drones",
  beforeLoad: requireModule("drone"),
  component: page("DronesRoute"),
});

const geofencesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/geofences",
  beforeLoad: requireModule("geofence"),
  component: page("GeofencesRoute"),
});

const osintRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/osint",
  // The review pipeline is platform-only; orgs see OSINT incidents on the map.
  beforeLoad: () => requirePlatform("support"),
  component: page("OsintRoute"),
});

const changePasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/change-password",
  beforeLoad: requireSession,
  component: page("ChangePasswordRoute"),
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/login",
  component: page("LoginRoute"),
});

const adminOrganizationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/organizations",
  beforeLoad: requireAdmin,
  component: page("AdminOrganizationsRoute"),
});

// The organization page's tab lives in the address, so a link can open it on
// Channels or Platform and a refresh keeps the tab.
const validateTab = (search) => (search.tab ? { tab: String(search.tab) } : {});

const adminOrganizationDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/organizations/$id",
  beforeLoad: requireAdmin,
  validateSearch: validateTab,
  component: page("AdminOrganizationDetailRoute"),
});

// The Radio network page was folded into Organizations; old links still land.
const adminRadioNetworkRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/radio-network",
  beforeLoad: () => {
    throw redirect({ to: "/admin/organizations" });
  },
});

const platformStaffRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/team",
  beforeLoad: requireOwner,
  component: page("PlatformStaffRoute"),
});

const statsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/stats",
  beforeLoad: requireOwner,
  component: page("StatsRoute"),
});

const orgAdminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/org/admin",
  beforeLoad: requireOrgAdmin,
  validateSearch: validateTab,
  component: page("OrgAdminRoute"),
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  alarmsRoute,
  replayRoute,
  devicesRoute,
  dronesRoute,
  geofencesRoute,
  osintRoute,
  loginRoute,
  changePasswordRoute,
  adminOrganizationsRoute,
  adminOrganizationDetailRoute,
  adminRadioNetworkRoute,
  platformStaffRoute,
  statsRoute,
  orgAdminRoute,
]);

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

restoreQueryCache(queryClient, currentSession()).then((savedAt) => {
  noteRestoredAt(savedAt);
  persistQueryCache(queryClient, currentSession);
  createRoot(document.getElementById("root")).render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  registerServiceWorker();
});
