import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, ChevronRight, ClipboardList, Radio, RadioTower, Shield, UsersRound, Workflow } from "lucide-react";
import { useMemo } from "react";
import { getMe, getOrgAdmin, listOrgChannels } from "../../lib/api";
import { isPlatformOperator, isPlatformStaff } from "../../lib/platform-roles";
import { ChannelsTab } from "./ChannelsTab";
import { ActivityTab, PeopleTab, UnitsTab } from "./OrgSections";
import { PlatformTab } from "./PlatformTab";
import { RadiosTab } from "./RadiosTab";

const MANAGER_ROLES = ["org_owner", "org_admin", "admin"];

// One organization, the same page for both angles. An organization's own admin
// sees it at /org/admin; a platform admin opens any organization at
// /admin/organizations/<id> and sees exactly what that organization sees, plus
// a Platform tab for the things only the platform decides.
export function OrganizationPage({ orgId = null, tab = "radios", basePath }) {
  const navigate = useNavigate();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const user = meQuery.data?.user;
  const platform = isPlatformStaff(user);
  const membership = user?.active_membership || user?.memberships?.[0];

  const scope = orgId ?? "mine";
  const orgKey = useMemo(() => ["org-admin", scope], [scope]);
  const channelsKey = useMemo(() => ["org-channels", scope], [scope]);
  const orgQuery = useQuery({ queryKey: orgKey, queryFn: () => getOrgAdmin(orgId), enabled: Boolean(user) });
  const channelsQuery = useQuery({ queryKey: channelsKey, queryFn: () => listOrgChannels(orgId), enabled: Boolean(user) });

  const data = orgQuery.data || {};
  const organization = data.organization;
  const devices = useMemo(() => data.devices || [], [data.devices]);
  const units = data.units || [];
  const users = data.users || [];
  const audit = data.audit || [];
  const channels = channelsQuery.data?.channels || [];
  const discovered = organization?.status === "discovered";

  const ctx = {
    orgId,
    orgKey,
    channelsKey,
    platform,
    canWrite: isPlatformOperator(user),
    // A discovered organization belongs to another operator: MOMAS can look,
    // and the server refuses changes, so nothing offers them.
    canManage: !discovered && (platform ? isPlatformOperator(user) : MANAGER_ROLES.includes(membership?.role)),
  };

  const activeRadios = devices.filter((device) => device.active);
  const online = activeRadios.filter((device) => device.pocstars_online).length;
  const liveChannels = channels.filter((channel) => channel.active);
  const tabs = [
    { id: "radios", label: "Radios", icon: Radio, count: activeRadios.length },
    { id: "channels", label: "Channels", icon: RadioTower, count: liveChannels.length },
    { id: "units", label: "Units", icon: Workflow, count: units.length },
    { id: "people", label: "People", icon: UsersRound, count: users.length },
    { id: "activity", label: "Activity", icon: ClipboardList },
    ...(platform && orgId ? [{ id: "platform", label: "Platform", icon: Shield }] : []),
  ];
  const current = tabs.some((entry) => entry.id === tab) ? tab : "radios";
  const loading = orgQuery.isLoading || meQuery.isLoading;

  const selectTab = (next) => navigate({ to: basePath, params: orgId ? { id: String(orgId) } : undefined, search: next === "radios" ? {} : { tab: next } });

  if (orgQuery.error) {
    return (
      <Shell>
        <p className="text-sm text-ops-red">{orgQuery.error.message}</p>
      </Shell>
    );
  }

  return (
    <Shell>
      <header className="mb-6">
        {platform && orgId ? (
          <nav className="mb-3 flex items-center gap-1 text-[11px] text-neutral-500">
            <Link to="/admin/organizations" className="hover:text-neutral-200">Organizations</Link>
            <ChevronRight size={12} />
            <span className="text-neutral-400">{organization?.name || "…"}</span>
          </nav>
        ) : null}
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-bold text-neutral-100">
          <Building2 size={20} className="text-ops-red" />
          {organization?.name || <span className="inline-block h-5 w-48 animate-pulse rounded bg-white/[0.07]" />}
          {discovered ? (
            <span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2 py-0.5 text-[10px] font-bold uppercase text-sky-300">Discovered</span>
          ) : organization && organization.status !== "active" ? (
            <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] font-bold uppercase text-neutral-400">{organization.status}</span>
          ) : null}
        </h1>
        <p className="mt-1 text-[12px] text-neutral-500">
          {loading ? "Loading…" : `${activeRadios.length} radios · ${online} online · ${liveChannels.length} channels · ${users.length} people`}
        </p>
        {discovered && platform ? (
          <p className="mt-3 max-w-3xl rounded-md border border-sky-400/25 bg-sky-400/[0.07] px-3 py-2 text-[11px] text-sky-200">
            Found on the shared radio network and run by another operator. You can look, but nothing here can be
            changed until it is promoted on the Platform tab.
          </p>
        ) : null}
      </header>

      <div className="mb-5 flex flex-wrap gap-1 border-b border-white/10">
        {tabs.map((entry) => {
          const Icon = entry.icon;
          const active = current === entry.id;
          return (
            <button
              key={entry.id}
              type="button"
              onClick={() => selectTab(entry.id)}
              className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-xs font-bold transition ${
                active ? "border-ops-red text-neutral-100" : "border-transparent text-neutral-500 hover:text-neutral-200"
              }`}
            >
              <Icon size={13} className={active ? "text-ops-red" : ""} /> {entry.label}
              {entry.count !== undefined && !loading ? (
                <span className="rounded-full bg-white/[0.06] px-1.5 text-[10px] font-normal text-neutral-400">{entry.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      {current === "radios" ? <RadiosTab ctx={ctx} devices={devices} channels={channels} units={units} loading={loading} /> : null}
      {current === "channels" ? <ChannelsTab ctx={ctx} channels={channels} devices={devices} units={units} loading={loading || channelsQuery.isLoading} /> : null}
      {current === "units" ? <UnitsTab ctx={ctx} units={units} loading={loading} /> : null}
      {current === "people" ? <PeopleTab ctx={ctx} users={users} units={units} loading={loading} /> : null}
      {current === "activity" ? <ActivityTab audit={audit} loading={loading} /> : null}
      {current === "platform" ? <PlatformTab orgId={orgId} devices={devices} /> : null}
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <main className="device-page bg-ops-bg px-6 pb-10 pt-[calc(var(--ops-chrome)+2rem)] text-neutral-200">
      <div className="mx-auto max-w-[1400px]">{children}</div>
    </main>
  );
}
