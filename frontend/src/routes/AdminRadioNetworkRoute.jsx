import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronRight, RadioTower, Search, X } from "lucide-react";
import { useMemo, useState } from "react";
import { getRadioNetwork } from "../lib/api";

// Who owns what on the radio network. Org admins already know what is theirs;
// the platform needs the whole estate in one place, and above all the groups
// that hold radios from more than one organization - those were made outside
// MOMAS and mean one org's radios hear another's traffic.
export function AdminRadioNetworkRoute() {
  const networkQuery = useQuery({
    queryKey: ["radio-network"],
    queryFn: getRadioNetwork,
    staleTime: 60_000,
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [openOrgId, setOpenOrgId] = useState(null);
  const [channelId, setChannelId] = useState(null);

  const network = useMemo(() => shapeNetwork(networkQuery.data), [networkQuery.data]);
  const term = search.trim().toLowerCase();

  const orgs = useMemo(() => {
    if (filter === "issues") return network.orgs.filter((org) => org.mixedCount || org.idleCount);
    if (filter === "radios") return network.orgs.filter((org) => org.radio_count > 0);
    return network.orgs;
  }, [network.orgs, filter]);

  const matches = useMemo(() => {
    if (!term) return [];
    return network.radios
      .filter((radio) =>
        [radio.name, radio.imei, radio.device_id].some((value) => value && String(value).toLowerCase().includes(term)),
      )
      .slice(0, 40);
  }, [network.radios, term]);

  const channel = channelId ? network.channelsById.get(channelId) : null;

  return (
    <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
            <RadioTower size={22} /> Radio network
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">Every organization's radios and channels, and the groups that mix them.</p>
        </div>
        <label className="flex w-full max-w-sm items-center gap-2 rounded-md border border-white/10 bg-white/[0.03] px-3 py-2">
          <Search size={14} className="text-neutral-500" />
          <span className="sr-only">Find a radio</span>
          <input
            className="flex-1 bg-transparent text-xs text-neutral-200 placeholder:text-neutral-600 focus:outline-none"
            placeholder="Find a radio by name or IMEI"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button type="button" aria-label="Clear search" className="text-neutral-500 hover:text-neutral-200" onClick={() => setSearch("")}>
              <X size={14} />
            </button>
          ) : null}
        </label>
      </header>

      <section className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label="Totals">
        <Stat label="Radios on the network" value={network.radios.length} hint={`${network.onlineCount} online now`} loading={networkQuery.isLoading} />
        <Stat label="Organizations with radios" value={network.orgsWithRadios} hint={`${network.channels.length} channels in all`} loading={networkQuery.isLoading} />
        <Stat
          label="Mixed groups"
          value={network.mixedChannels.length}
          hint="Hold radios from another organization"
          tone={network.mixedChannels.length ? "warn" : null}
          loading={networkQuery.isLoading}
        />
        <Stat label="Radios on no channel" value={network.idleRadios.length} hint="Can't hear or be heard" loading={networkQuery.isLoading} />
      </section>

      {networkQuery.error ? <p className="mb-4 text-xs text-ops-red">{networkQuery.error.message}</p> : null}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <section className="glass-panel overflow-hidden rounded-lg" aria-label="Organizations">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-4 py-3">
            <h2 className="text-[13px] font-bold text-neutral-100">Who owns what</h2>
            <div className="flex gap-1">
              {[
                { key: "all", label: "All" },
                { key: "radios", label: "With radios" },
                { key: "issues", label: "Needs attention" },
              ].map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setFilter(tab.key)}
                  className={`rounded-full border px-3 py-1 text-[11px] font-bold transition ${
                    filter === tab.key
                      ? "border-ops-red/50 bg-ops-red/15 text-ops-red"
                      : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-neutral-200"
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[minmax(0,2.4fr)_repeat(3,minmax(0,1fr))] gap-3 border-b border-white/10 px-4 py-2 text-[10px] uppercase tracking-wide text-neutral-500">
            <span>Organization</span>
            <span>Radios</span>
            <span>Channels</span>
            <span>Consoles</span>
          </div>
          {networkQuery.isLoading ? <SkeletonRows /> : null}
          <div className="divide-y divide-white/5">
            {orgs.map((org) => {
              const open = openOrgId === org.id;
              return (
                <div key={org.id}>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenOrgId(open ? null : org.id)}
                    className={`grid w-full grid-cols-[minmax(0,2.4fr)_repeat(3,minmax(0,1fr))] items-center gap-3 px-4 py-3 text-left text-xs transition hover:bg-white/[0.04] ${
                      open ? "bg-white/[0.04]" : ""
                    }`}
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <ChevronRight size={13} className={`shrink-0 text-neutral-500 transition-transform ${open ? "rotate-90" : ""}`} />
                      <span className="truncate font-bold text-neutral-100">{org.name}</span>
                      {org.status === "discovered" ? <Tag tone="info">Discovered</Tag> : null}
                      {org.mixedCount ? <Tag tone="warn">{org.mixedCount} mixed</Tag> : null}
                    </span>
                    <span className="text-neutral-300">
                      {org.radio_count}
                      {org.radio_count ? <span className="text-neutral-600"> · {org.online_count} on</span> : null}
                    </span>
                    <span className="text-neutral-300">{org.channels.length}</span>
                    <span className="text-neutral-300">{org.radio_seats ?? "-"}</span>
                  </button>
                  {open ? (
                    <div className="space-y-1.5 px-4 pb-3 pl-10">
                      {org.channels.map((item) => (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => {
                            setChannelId(item.id);
                            setSearch("");
                          }}
                          className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-xs transition ${
                            channelId === item.id
                              ? "border-ops-red/40 bg-ops-red/10"
                              : "border-white/5 bg-white/[0.03] hover:bg-white/[0.06]"
                          }`}
                        >
                          <span className="flex min-w-0 items-center gap-2">
                            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${item.online_count ? "bg-ops-green" : "bg-neutral-600"}`} />
                            <span className="truncate text-neutral-200">{item.name}</span>
                            {item.foreign.length ? <Tag tone="warn">Mixed</Tag> : null}
                          </span>
                          <span className="shrink-0 text-[11px] text-neutral-500">
                            {item.unit_name ? `${item.unit_name} · ` : ""}
                            {item.radio_count} radio{item.radio_count === 1 ? "" : "s"}
                          </span>
                        </button>
                      ))}
                      {!org.channels.length ? <p className="py-1 text-[11px] text-neutral-600">No channels</p> : null}
                      <Link
                        to="/admin/organizations/$id"
                        params={{ id: String(org.id) }}
                        className="inline-flex items-center gap-1 pt-1 text-[11px] font-bold text-ops-red hover:opacity-80"
                      >
                        Open company <ChevronRight size={12} />
                      </Link>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {!networkQuery.isLoading && !orgs.length ? (
              <p className="px-4 py-10 text-center text-[12px] text-neutral-500">Nothing needs attention</p>
            ) : null}
          </div>
        </section>

        <aside className="space-y-6">
          {term ? (
            <RadioMatches matches={matches} network={network} term={term} onChannel={(id) => { setChannelId(id); setSearch(""); }} />
          ) : channel ? (
            <ChannelDetail channel={channel} network={network} onClose={() => setChannelId(null)} />
          ) : null}
          <Attention network={network} loading={networkQuery.isLoading} onChannel={(id, orgId) => { setChannelId(id); setOpenOrgId(orgId); setSearch(""); }} />
        </aside>
      </div>
    </main>
  );
}

// Joins the flat rows into the shapes the view reads, once per fetch.
function shapeNetwork(data) {
  const organizations = data?.organizations || [];
  const radios = data?.radios || [];
  const orgsById = new Map(organizations.map((org) => [Number(org.id), org]));
  const foreignByChannel = new Map();
  for (const row of data?.foreign || []) {
    const list = foreignByChannel.get(Number(row.channel_id)) || [];
    list.push({ organization_id: row.organization_id, radio_count: row.radio_count });
    foreignByChannel.set(Number(row.channel_id), list);
  }
  const channels = (data?.channels || []).map((channel) => ({
    ...channel,
    foreign: foreignByChannel.get(Number(channel.id)) || [],
  }));
  const channelsById = new Map(channels.map((channel) => [Number(channel.id), channel]));
  const channelsByOrg = new Map();
  for (const channel of channels) {
    const list = channelsByOrg.get(Number(channel.organization_id)) || [];
    list.push(channel);
    channelsByOrg.set(Number(channel.organization_id), list);
  }
  const idleRadios = radios.filter((radio) => !radio.channel_ids?.length);
  const idleByOrg = new Map();
  for (const radio of idleRadios) {
    const key = Number(radio.organization_id);
    idleByOrg.set(key, (idleByOrg.get(key) || 0) + 1);
  }
  const orgs = organizations.map((org) => {
    const own = channelsByOrg.get(Number(org.id)) || [];
    return {
      ...org,
      channels: own,
      mixedCount: own.filter((channel) => channel.foreign.length).length,
      idleCount: idleByOrg.get(Number(org.id)) || 0,
    };
  });
  return {
    orgs,
    orgsById,
    radios,
    channels,
    channelsById,
    mixedChannels: channels.filter((channel) => channel.foreign.length),
    idleRadios,
    onlineCount: radios.filter((radio) => radio.pocstars_online).length,
    orgsWithRadios: organizations.filter((org) => org.radio_count > 0).length,
  };
}

function orgName(network, organizationId) {
  if (organizationId == null) return "Unassigned pool";
  return network.orgsById.get(Number(organizationId))?.name || `Organization ${organizationId}`;
}

function ChannelDetail({ channel, network, onClose }) {
  const foreignTotal = channel.foreign.reduce((sum, row) => sum + row.radio_count, 0);
  const ownCount = channel.radio_count - foreignTotal;
  return (
    <section className="glass-panel space-y-4 rounded-lg p-4" aria-label="Channel">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] text-neutral-500">Channel · owned by {orgName(network, channel.organization_id)}</p>
          <h2 className="mt-1 truncate text-lg font-bold text-neutral-100">{channel.name}</h2>
          <p className="mt-0.5 text-[11px] text-neutral-500">
            {channel.unit_name ? `${channel.unit_name} only` : "Whole organization"} · {channel.radio_count} radio{channel.radio_count === 1 ? "" : "s"} · {channel.online_count} online
          </p>
        </div>
        <button type="button" aria-label="Close channel" className="rounded p-1 text-neutral-500 hover:bg-white/10 hover:text-neutral-200" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
      {channel.foreign.length ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200">
          This group holds radios from {channel.foreign.length === 1 ? "another organization" : `${channel.foreign.length} other organizations`}. They hear this channel's traffic. It was set up outside MOMAS.
        </p>
      ) : null}
      <div className="space-y-1.5">
        <OrgShare name={orgName(network, channel.organization_id)} count={ownCount} owner />
        {channel.foreign.map((row) => (
          <OrgShare key={String(row.organization_id)} name={orgName(network, row.organization_id)} count={row.radio_count} />
        ))}
      </div>
    </section>
  );
}

function OrgShare({ name, count, owner = false }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md bg-white/[0.03] px-3 py-2 text-xs">
      <span className="min-w-0">
        <span className="block truncate font-bold text-neutral-200">{name}</span>
        <span className="text-[11px] text-neutral-500">{count} radio{count === 1 ? "" : "s"}</span>
      </span>
      {owner ? <Tag tone="ok">Owner</Tag> : <Tag tone="warn">Other org</Tag>}
    </div>
  );
}

function RadioMatches({ matches, network, term, onChannel }) {
  return (
    <section className="glass-panel overflow-hidden rounded-lg" aria-label="Radios found">
      <div className="border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
        {matches.length ? `${matches.length === 40 ? "First 40" : matches.length} radio${matches.length === 1 ? "" : "s"} matching “${term}”` : `No radio matches “${term}”`}
      </div>
      <div className="divide-y divide-white/5">
        {matches.map((radio) => (
          <div key={radio.device_id} className="space-y-1.5 px-4 py-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="flex min-w-0 items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${radio.pocstars_online ? "bg-ops-green" : "bg-neutral-600"}`} />
                <span className="truncate font-bold text-neutral-100">{radio.name || radio.device_id}</span>
              </span>
              <span className="shrink-0 text-[11px] text-neutral-400">{orgName(network, radio.organization_id)}</span>
            </div>
            {radio.imei ? <p className="text-[11px] text-neutral-600">IMEI {radio.imei}</p> : null}
            <div className="flex flex-wrap gap-1">
              {radio.channel_ids.map((id) => {
                const item = network.channelsById.get(Number(id));
                if (!item) return null;
                const foreign = Number(item.organization_id) !== Number(radio.organization_id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onChannel(Number(id))}
                    className={`rounded-full border px-2 py-0.5 text-[10px] transition hover:opacity-80 ${
                      foreign ? "border-amber-500/40 bg-amber-500/10 text-amber-200" : "border-white/10 bg-white/[0.04] text-neutral-300"
                    }`}
                    title={foreign ? `Owned by ${orgName(network, item.organization_id)}` : undefined}
                  >
                    {item.name}
                  </button>
                );
              })}
              {!radio.channel_ids.length ? <span className="text-[11px] text-neutral-600">On no channel</span> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Attention({ network, loading, onChannel }) {
  if (loading) return null;
  const idleByOrg = [...network.orgs].filter((org) => org.idleCount).sort((a, b) => b.idleCount - a.idleCount);
  return (
    <section className="glass-panel overflow-hidden rounded-lg" aria-label="Needs attention">
      <div className="border-b border-white/10 px-4 py-3">
        <h2 className="text-[13px] font-bold text-neutral-100">Needs attention</h2>
      </div>
      <div className="divide-y divide-white/5">
        {network.mixedChannels.map((channel) => (
          <button
            key={channel.id}
            type="button"
            onClick={() => onChannel(Number(channel.id), Number(channel.organization_id))}
            className="flex w-full items-center gap-3 px-4 py-3 text-left text-xs transition hover:bg-white/[0.04]"
          >
            <AlertTriangle size={14} className="shrink-0 text-amber-400" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold text-neutral-200">
                {channel.name} <span className="font-normal text-neutral-500">· {orgName(network, channel.organization_id)}</span>
              </span>
              <span className="block truncate text-[11px] text-neutral-500">
                Also holds radios from {channel.foreign.map((row) => orgName(network, row.organization_id)).join(", ")}
              </span>
            </span>
            <ChevronRight size={14} className="shrink-0 text-neutral-600" />
          </button>
        ))}
        {idleByOrg.map((org) => (
          <div key={`idle-${org.id}`} className="flex items-center gap-3 px-4 py-3 text-xs">
            <span className="grid h-5 min-w-5 shrink-0 place-items-center rounded bg-white/10 px-1 text-[10px] font-bold text-neutral-200">{org.idleCount}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold text-neutral-200">{org.name}</span>
              <span className="text-[11px] text-neutral-500">Radio{org.idleCount === 1 ? "" : "s"} on no channel</span>
            </span>
          </div>
        ))}
        {!network.mixedChannels.length && !idleByOrg.length ? (
          <p className="px-4 py-8 text-center text-[12px] text-neutral-500">Nothing needs attention</p>
        ) : null}
      </div>
    </section>
  );
}

function Stat({ label, value, hint, tone = null, loading = false }) {
  return (
    <div className="glass-panel rounded-lg px-4 py-3">
      <p className="text-[11px] text-neutral-500">{label}</p>
      {loading ? (
        <div className="mt-2 h-7 w-16 animate-pulse rounded bg-white/10" />
      ) : (
        <p className={`mt-1 text-2xl font-bold ${tone === "warn" ? "text-amber-400" : "text-neutral-100"}`}>{value}</p>
      )}
      <p className="mt-0.5 text-[11px] text-neutral-600">{hint}</p>
    </div>
  );
}

function Tag({ tone, children }) {
  const styles = {
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    info: "border-sky-400/30 bg-sky-400/10 text-sky-300",
    ok: "border-green-500/30 bg-green-500/10 text-ops-green",
  };
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-bold uppercase ${styles[tone] || styles.info}`}>
      {children}
    </span>
  );
}

function SkeletonRows() {
  return (
    <div className="divide-y divide-white/5">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3.5">
          <div className="h-3 w-40 animate-pulse rounded bg-white/10" />
          <div className="ml-auto h-3 w-24 animate-pulse rounded bg-white/5" />
        </div>
      ))}
    </div>
  );
}
