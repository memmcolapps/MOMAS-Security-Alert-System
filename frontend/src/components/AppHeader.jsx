import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity, Building2, ChevronDown, FileSearch, History, LogOut, Map, MapPinned, Menu, Plane, Radio, ShieldAlert, ShieldCheck, Siren, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getActiveOrganizationId, getMe, getPlatformStats, getServerStatus, setActiveOrganizationId, setAuthToken } from "../lib/api";
import { clearOfflineCache } from "../lib/offline-cache";
import { PLATFORM_ROLE_LABELS, isPlatformOwner, isPlatformStaff } from "../lib/platform-roles";
import { MODULES, hasRadioNetwork, moduleSet } from "../lib/modules";
import { ListenControl } from "./LiveRadioBar";
import { LocationStatus } from "./LocationStatus";

export function AppHeader() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const router = useRouterState();
  const path = router.location.pathname;

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const user = meQuery.data?.user;
  const isAdmin = isPlatformStaff(user);
  const isOwner = isPlatformOwner(user);
  const roleLabel = PLATFORM_ROLE_LABELS[user?.platform_role] || "Platform";
  const memberships = user?.memberships || [];
  const org = user?.active_membership || memberships.find((membership) => String(membership.organization_id) === String(getActiveOrganizationId())) || memberships[0] || null;
  const canManageOrg = isAdmin || ["org_owner", "org_admin", "unit_admin", "admin"].includes(org?.role);
  const modules = isAdmin ? new Set(MODULES) : moduleSet(org?.modules);
  const accessSummary = org
    ? org.all_states
      ? "all states"
      : `${org.state_count || 0} state${org.state_count === 1 ? "" : "s"}`
    : null;
  const avatarLetter = (org?.name || user?.name || user?.email || "?").trim()[0]?.toUpperCase();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onClick = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const isActive = (prefix) => path === prefix || path.startsWith(`${prefix}/`);

  // Platform administration lives in the account menu, not here: this bar is
  // operational views only, so it stays short enough to fit a tablet.
  const navItems = [
    { to: "/", icon: Map, label: "Map", active: path === "/" },
    ...(hasRadioNetwork(modules)
      ? [
          { to: "/replay", icon: History, label: "Replay", active: isActive("/replay") },
          { to: "/alarms", icon: Siren, label: "Alarms", active: isActive("/alarms") },
          { to: "/devices", icon: Radio, label: "Devices", active: isActive("/devices") },
        ]
      : []),
    ...(modules.has("geofence") ? [{ to: "/geofences", icon: MapPinned, label: "Geofences", active: isActive("/geofences") }] : []),
    ...(isAdmin ? [{ to: "/osint", icon: FileSearch, label: "OSINT", active: isActive("/osint") }] : []),
    ...(modules.has("drone") ? [{ to: "/drones", icon: Plane, label: "Drones", active: isActive("/drones") }] : []),
    ...(!isAdmin && canManageOrg ? [{ to: "/org/admin", icon: UsersRound, label: "Admin", active: isActive("/org/admin") }] : []),
  ];

  function logout() {
    setAuthToken(null);
    clearOfflineCache();
    queryClient.clear();
    navigate({ to: "/login" });
  }

  function switchOrganization(organizationId) {
    setActiveOrganizationId(organizationId);
    setMenuOpen(false);
    queryClient.clear();
    navigate({ to: "/" });
  }

  return (
    <header className="relative z-10 border-b border-white/10 bg-black/70 backdrop-blur">
      <div className="flex h-12 items-center gap-3 px-3 text-neutral-200 md:gap-4 md:px-4">
        <Link to="/" className="flex shrink-0 items-center gap-2 whitespace-nowrap text-[12px] font-bold tracking-wide text-ops-red">
          <ShieldAlert size={16} />
          <span>EPAIL <span className="hidden text-neutral-400 min-[400px]:inline">Intelligence</span></span>
        </Link>

        {org ? (
          <span className="hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 text-[10px] font-bold text-neutral-300 2xl:inline-flex">
            <span className="h-1.5 w-1.5 rounded-full bg-ops-green" />
            {org.name}
          </span>
        ) : isAdmin ? (
          <span className="hidden shrink-0 items-center gap-2 whitespace-nowrap rounded-full border border-ops-red/40 bg-red-500/10 px-2.5 py-0.5 text-[10px] font-bold text-ops-red 2xl:inline-flex">
            {roleLabel}
          </span>
        ) : null}

        {/* Labels need ~1,100px with every item showing. Below 1,180px the
            links go icon-only; on phones they move into the account menu. */}
        <nav className="hidden min-w-0 items-center gap-1 overflow-x-auto text-[11px] font-bold [scrollbar-width:none] md:flex">
          {navItems.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>

        {/* No whitespace-nowrap here: the location and Listen pop-ups live
            inside this box and inherit it, so their paragraphs ran off the
            panel. Each button keeps itself on one line. */}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <ListenControl />
          <LocationStatus />
        </div>

        <div ref={menuRef}>
          {user ? (
            <button
              onClick={() => setMenuOpen((value) => !value)}
              aria-label="Menu"
              aria-expanded={menuOpen}
              className="inline-flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded border border-white/10 bg-white/[0.03] px-2 text-[11px] hover:bg-white/[0.07] active:bg-white/[0.1] md:h-auto md:px-2.5 md:py-1"
            >
              <Menu size={16} className="text-neutral-300 md:hidden" />
              <span className="grid h-5 w-5 place-items-center rounded-full bg-ops-red text-[10px] font-bold text-black">
                {avatarLetter}
              </span>
              <span className="hidden max-w-[180px] truncate text-neutral-300 xl:inline">{user.email}</span>
              <ChevronDown size={12} className="hidden text-neutral-500 md:block" />
            </button>
          ) : null}

          {menuOpen ? (
            <div className="absolute right-3 top-full mt-1 max-h-[calc(100dvh-4rem)] w-64 overflow-y-auto rounded-md border border-white/10 bg-black/95 p-2 shadow-xl backdrop-blur md:right-4 md:w-56">
              <div className="border-b border-white/10 pb-1 md:hidden">
                {navItems.map((item) => (
                  <MenuLink key={item.to} {...item} onNavigate={() => setMenuOpen(false)} />
                ))}
              </div>
              <div className="border-b border-white/10 px-2 pb-2 text-[11px] text-neutral-400">
                <div className="truncate font-bold text-neutral-200">{user?.name || user?.email}</div>
                <div className="truncate text-neutral-500">{user?.email}</div>
                {org ? (
                  <div className="mt-1 truncate text-[10px] text-neutral-500">
                    <span className="text-neutral-300">{org.name}</span> · {org.role} · {accessSummary}
                  </div>
                ) : isAdmin ? (
                  <div className="mt-1 text-[10px] text-ops-red">{roleLabel} · all companies</div>
                ) : null}
              </div>
              {isAdmin ? (
                <div className="border-b border-white/10 py-1">
                  <p className="px-2 pb-1 pt-0.5 text-[9px] font-bold uppercase tracking-wide text-neutral-600">
                    Platform
                  </p>
                  <MenuLink
                    to="/admin/organizations"
                    icon={Building2}
                    label="Organizations"
                    active={isActive("/admin/organizations")}
                    onNavigate={() => setMenuOpen(false)}
                  />
                  {isOwner ? (
                    <MenuLink
                      to="/admin/stats"
                      icon={Activity}
                      label="System health"
                      active={isActive("/admin/stats")}
                      onNavigate={() => setMenuOpen(false)}
                      // Numbers start loading on hover, so the page opens filled in.
                      onHover={() => {
                        queryClient.prefetchQuery({
                          queryKey: ["platform-stats", "7d"],
                          queryFn: () => getPlatformStats("7d"),
                          staleTime: 15_000,
                        });
                        queryClient.prefetchQuery({
                          queryKey: ["platform-servers"],
                          queryFn: getServerStatus,
                          staleTime: 10_000,
                        });
                      }}
                    />
                  ) : null}
                  {isOwner ? (
                    <MenuLink
                      to="/admin/team"
                      icon={ShieldCheck}
                      label="Platform team"
                      active={isActive("/admin/team")}
                      onNavigate={() => setMenuOpen(false)}
                    />
                  ) : null}
                </div>
              ) : null}
              {!isAdmin && memberships.length > 1 ? (
                <div className="border-b border-white/10 py-1">
                  {memberships.map((membership) => (
                    <button
                      className={`flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-[11px] ${
                        Number(org?.organization_id) === Number(membership.organization_id)
                          ? "bg-white/10 text-ops-red"
                          : "text-neutral-300 hover:bg-white/10"
                      }`}
                      key={membership.organization_id}
                      onClick={() => switchOrganization(membership.organization_id)}
                    >
                      <span className="min-w-0 truncate">{membership.name}</span>
                      <span className="shrink-0 text-[10px] text-neutral-500">{membership.role}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <button
                className="mt-1 inline-flex w-full items-center gap-2 rounded px-2 py-2.5 text-[13px] text-neutral-300 hover:bg-white/10 md:py-1.5 md:text-[11px]"
                onClick={logout}
              >
                <LogOut size={13} /> Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function MenuLink({ to, icon: Icon, label, active, onNavigate, onHover }) {
  return (
    <Link
      to={to}
      onClick={onNavigate}
      onMouseEnter={onHover}
      onFocus={onHover}
      className={`flex w-full items-center gap-2 rounded px-2 py-2.5 text-[13px] md:py-1.5 md:text-[11px] ${
        active ? "bg-white/10 text-ops-red" : "text-neutral-300 hover:bg-white/10"
      }`}
    >
      <Icon size={14} /> {label}
    </Link>
  );
}

function NavItem({ to, icon: Icon, label, active }) {
  return (
    <Link
      to={to}
      title={label}
      aria-label={label}
      className={`inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-2.5 transition min-[1180px]:h-auto min-[1180px]:py-1 ${
        active ? "bg-white/10 text-ops-red" : "text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
      }`}
    >
      <Icon size={15} className="min-[1180px]:h-[13px] min-[1180px]:w-[13px]" />
      <span className="hidden min-[1180px]:inline">{label}</span>
    </Link>
  );
}
