import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Activity, AlertTriangle, CheckCircle2, CircleSlash, ShieldCheck, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { getPlatformStats, getServerStatus, pingServer } from "../lib/api";

const RANGES = [
  { id: "24h", label: "24 hours" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
];

// Checked for colour-blind separation on this dark surface. Blue is the normal
// case and amber the one to look at, so the pair never relies on red vs green.
const ON_TIME = "#3d8bfd";
const LATE = "#b87d00";

const EVENT_LABELS = {
  login_failed: "Wrong password",
  bad_token: "Forged or broken session",
  forbidden: "Tried something not allowed",
  probe: "Scanner probe",
};

export function StatsRoute() {
  const [range, setRange] = useState("7d");
  const query = useQuery({
    queryKey: ["platform-stats", range],
    queryFn: () => getPlatformStats(range),
    // Switching range keeps the old numbers on screen until the new ones land.
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
  const stats = query.data;

  return (
    <main className="device-page bg-ops-bg px-6 pb-10 pt-[calc(var(--ops-chrome)+2rem)] text-neutral-200">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
            <Activity size={22} /> System health
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            How reliably alarms get through, what has been failing, and what was turned away.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {stats ? (
            <span className={`text-[10px] text-neutral-600 transition-opacity ${query.isFetching ? "opacity-50" : ""}`}>
              Updated {new Date(stats.generated_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          ) : null}
          <div className="inline-flex rounded-md border border-white/10 bg-white/[0.03] p-0.5" role="group" aria-label="Period">
            {RANGES.map((option) => (
              <button
                key={option.id}
                aria-pressed={range === option.id}
                onClick={() => setRange(option.id)}
                className={`rounded px-3 py-1 text-[11px] font-bold transition ${
                  range === option.id ? "bg-ops-red text-black" : "text-neutral-400 hover:text-neutral-100"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <Servers />

      <div className="mt-8">
        {query.isError && !stats ? (
          <div className="rounded border border-ops-red/30 bg-red-500/10 px-3 py-2 text-xs text-ops-red">
            {query.error?.message || "The stats could not be loaded."}
          </div>
        ) : !stats ? (
          <Skeleton />
        ) : (
          <Body stats={stats} />
        )}
      </div>
    </main>
  );
}

function Body({ stats }) {
  const { sos, security, lines } = stats;
  const onTimePct = pct(sos.on_time, sos.total);
  const passing = security.checks.filter((check) => check.state === "ok").length;
  const countingSince = stats.counting_since ? new Date(stats.counting_since) : null;

  return (
    <>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Tile label="Alarms received" value={sos.total} hint={sos.open_now ? `${sos.open_now} open right now` : "None open right now"} />
        <Tile
          label={`On a console within ${stats.on_time_seconds} s`}
          value={onTimePct === null ? "–" : `${onTimePct}%`}
          hint={sos.total ? `${sos.on_time} of ${sos.total} alarms` : "No alarms in this period"}
          tone={onTimePct !== null && onTimePct < 90 ? "warn" : null}
        />
        <Tile
          label="Typical time to answer"
          value={duration(sos.answer_p50)}
          hint={sos.total ? `${sos.answered} of ${sos.total} answered` : "No alarms in this period"}
        />
        <Tile
          label="Requests turned away"
          value={security.turned_away.toLocaleString()}
          hint={`${passing} of ${security.checks.length} security checks pass`}
          tone={passing < security.checks.length ? "warn" : null}
        />
      </section>

      <SectionTitle>SOS alarms</SectionTitle>
      <section className="grid gap-3 lg:grid-cols-2">
        <Card title={stats.unit === "hour" ? "Alarms per hour" : "Alarms per day"}>
          <StackedBars
            unit={stats.unit}
            points={sos.series.map((point) => ({
              t: point.t,
              parts: [
                { label: "On time", value: point.total - point.late, color: ON_TIME },
                { label: `Later than ${stats.on_time_seconds} s`, value: point.late, color: LATE },
              ],
            }))}
            empty="No alarms in this period."
          />
        </Card>
        <Card title="From button press to console">
          <Facts
            rows={[
              ["Typical delay", duration(sos.delay_p50)],
              ["Slowest 1 in 20", duration(sos.delay_p95)],
              ["Slowest", duration(sos.delay_max)],
              ["Answered", fraction(sos.answered, sos.total)],
              ["Closed", fraction(sos.resolved, sos.total)],
              ["Slowest 1 in 20 to answer", duration(sos.answer_p95)],
              ["Arrived by fast link", viaText(sos.via_push, sos)],
              ["Arrived by backup check", viaText(sos.via_poll, sos)],
              ["Arrived with no console open", sos.consoles_known ? flagged(sos.nobody_watching) : "Not recorded yet"],
              ["Arrived without a location", flagged(sos.no_location)],
              ["From a radio not given to a company", flagged(sos.no_company)],
            ]}
          />
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
            Counts start when the radio server has the alarm. A press that never leaves the handset cannot be seen here.
          </p>
        </Card>
      </section>

      <SectionTitle>What can fail</SectionTitle>
      <section className="overflow-hidden rounded-lg border border-white/10 bg-white/[0.02]">
        {lines.map((line) => (
          <LineRow key={line.id} line={line} />
        ))}
      </section>
      {stats.areas.length || stats.feeds.length ? (
        <section className="mt-3 grid gap-3 lg:grid-cols-2">
          {stats.areas.length ? (
            <Card title="Server errors by part of the app">
              <Facts rows={stats.areas.map((area) => [area.area, `${area.errors} of ${area.requests.toLocaleString()}`])} />
            </Card>
          ) : null}
          {stats.feeds.length ? (
            <Card title="News sources that failed">
              <Facts rows={stats.feeds.map((feed) => [feed.source, `${feed.failed} failed, ${feed.ok} worked`])} />
            </Card>
          ) : null}
        </section>
      ) : null}

      <SectionTitle>Security</SectionTitle>
      <section className="grid gap-3 lg:grid-cols-2">
        <Card title={`${passing} of ${security.checks.length} checks pass`}>
          <ul className="divide-y divide-white/5">
            {security.checks.map((check) => (
              <li key={check.id} className="flex items-start gap-2.5 py-2">
                <CheckIcon state={check.state} />
                <div className="min-w-0">
                  <div className="text-xs font-bold text-neutral-200">{check.label}</div>
                  <div className="text-[11px] leading-snug text-neutral-500">{check.detail}</div>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[10px] leading-relaxed text-neutral-600">
            These are the checks the app can run on itself. They are not a full security review.
          </p>
        </Card>

        <Card title="Requests turned away">
          <StackedBars
            unit={stats.unit}
            points={security.series.map((point) => ({
              t: point.t,
              parts: [
                {
                  label: "Turned away",
                  value: point.login_failed + point.bad_token + point.forbidden + point.probe,
                  color: ON_TIME,
                },
              ],
            }))}
            empty={
              countingSince
                ? "Nothing was turned away in this period."
                : "Counting starts when this version goes live."
            }
          />
          <div className="mt-3 grid grid-cols-2 gap-x-4 sm:grid-cols-4">
            <Mini label="Wrong passwords" value={security.login_failed} />
            <Mini label="Forged sessions" value={security.bad_token} />
            <Mini label="Not allowed" value={security.forbidden} />
            <Mini label="Scanner probes" value={security.probe} />
          </div>
          <p className="mt-3 text-[10px] text-neutral-600">
            {security.login_ok.toLocaleString()} successful sign-ins in the same period.
          </p>
        </Card>
      </section>

      <section className="mt-3 grid gap-3 lg:grid-cols-2">
        <Card title="Where it came from">
          {security.top_ips.length ? (
            <Facts
              rows={security.top_ips.map((row) => [
                <span key={row.ip} className="font-mono">{row.ip}</span>,
                `${row.count} · ${row.types.map((type) => EVENT_LABELS[type] || type).join(", ")}`,
              ])}
            />
          ) : (
            <Empty>No addresses recorded.</Empty>
          )}
          {security.targeted.length ? (
            <>
              <h3 className="mb-1 mt-4 text-[10px] font-bold uppercase tracking-wide text-neutral-500">
                Accounts people tried to get into
              </h3>
              <Facts
                rows={security.targeted.map((row) => [
                  row.email,
                  `${row.count} wrong password${row.count === 1 ? "" : "s"}${row.real_account ? "" : " · no such account"}`,
                ])}
              />
            </>
          ) : null}
        </Card>
        {security.recent.length ? (
          <Card title="Most recent">
            <div className="divide-y divide-white/5">
              {security.recent.map((event) => (
                <div key={event.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-[11px]">
                  <span className="font-bold text-neutral-300">{EVENT_LABELS[event.type] || event.type}</span>
                  <span className="min-w-0 truncate text-neutral-500">{event.email || event.path}</span>
                  <span className="ml-auto whitespace-nowrap text-neutral-600">
                    <span className="font-mono">{event.ip || "unknown address"}</span> · {new Date(event.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </section>

      <p className="mt-6 text-[10px] leading-relaxed text-neutral-600">
        Alarm history goes back to the first alarm stored.{" "}
        {countingSince
          ? `Link uptime, request counts and security counts started on ${countingSince.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" })}.`
          : "Link uptime, request counts and security counts start when this version goes live."}
      </p>
    </>
  );
}

/* ---------- servers ---------- */

const BROWSER_PING_MS = 15_000;
const BROWSER_KEEP = 40;

/**
 * Times the trip from this browser to the MOMAS server and back. Paused while
 * the tab is hidden, so a page left open in the background costs nothing.
 */
function useBrowserPing() {
  const [samples, setSamples] = useState([]);
  useEffect(() => {
    let stopped = false;
    const ping = async () => {
      if (document.hidden) return;
      let ms = null;
      try {
        ms = await pingServer();
      } catch {
        ms = null;
      }
      if (!stopped) setSamples((list) => [...list, ms].slice(-BROWSER_KEEP));
    };
    void ping();
    const timer = window.setInterval(ping, BROWSER_PING_MS);
    document.addEventListener("visibilitychange", ping);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", ping);
    };
  }, []);
  return samples;
}

function browserCheck(samples, slowMs) {
  const times = samples.filter((ms) => ms !== null).sort((a, b) => a - b);
  const last = samples.length ? samples[samples.length - 1] : undefined;
  return {
    id: "browser",
    name: "From your browser",
    detail: "This page to the server and back",
    state: last === undefined ? "unknown" : last === null ? "down" : last > slowMs ? "slow" : "up",
    last_ms: last ?? null,
    last_error: last === null ? "No answer" : null,
    typical_ms: times.length ? times[Math.floor(times.length / 2)] : null,
    up_pct: samples.length ? (times.length / samples.length) * 100 : null,
    recent: samples,
  };
}

function Servers() {
  const query = useQuery({
    queryKey: ["platform-servers"],
    queryFn: getServerStatus,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
  const browserSamples = useBrowserPing();
  const data = query.data;

  return (
    <section aria-labelledby="servers-title">
      <h2 id="servers-title" className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">
        Servers
      </h2>
      {query.isError && !data ? (
        <div className="rounded border border-ops-red/30 bg-red-500/10 px-3 py-2 text-xs text-ops-red">
          {query.error?.message || "Server status could not be loaded."}
        </div>
      ) : !data ? (
        <div className="grid animate-pulse gap-3 lg:grid-cols-2" aria-busy="true" aria-label="Loading">
          <div className="h-[244px] rounded-lg border border-white/10 bg-white/[0.03]" />
          <div className="h-[244px] rounded-lg border border-white/10 bg-white/[0.03]" />
        </div>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            {data.servers.map((server) => {
              const checks =
                server.id === "contabo" ? [browserCheck(browserSamples, data.slow_ms), ...server.checks] : server.checks;
              return (
                <ServerCard
                  key={server.id}
                  server={{ ...server, state: worstState(checks.map((check) => check.state)) }}
                  checks={checks}
                  slowMs={data.slow_ms}
                  facts={serverFacts(server)}
                />
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-neutral-600">
            The server checks itself and the radio server every {data.every_seconds} s. Times and uptime cover the
            last 24 hours, or since it last restarted at{" "}
            {new Date(data.since).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.
          </p>
        </>
      )}
    </section>
  );
}

function serverFacts(server) {
  const facts = server.facts || {};
  if (server.id === "contabo") {
    return [
      ["EPAIL Intelligence running for", duration(facts.running_seconds)],
      ["Processor load", facts.cpu_load_pct === null || facts.cpu_load_pct === undefined ? "–" : `${facts.cpu_load_pct}%`],
      ["Memory in use", facts.memory_used_pct === null || facts.memory_used_pct === undefined ? "–" : `${facts.memory_used_pct}%`],
    ];
  }
  return [
    [
      "Last alarm check answered",
      facts.last_alarm_check_at
        ? `${duration(Math.max(0, (Date.now() - new Date(facts.last_alarm_check_at).getTime()) / 1000))} ago`
        : "Not yet",
    ],
    ["Radio consoles in use", facts.bridge_seats ?? "–"],
  ];
}

function worstState(states) {
  for (const state of ["down", "slow", "unknown", "up"]) if (states.includes(state)) return state;
  return "off";
}

const STATE_STYLE = {
  up: { label: "Up", className: "text-ops-green", Icon: CheckCircle2 },
  slow: { label: "Slow", className: "text-amber-300", Icon: AlertTriangle },
  down: { label: "Down", className: "text-ops-red", Icon: XCircle },
  unknown: { label: "Checking", className: "text-neutral-500", Icon: Activity },
  off: { label: "Not set up", className: "text-neutral-500", Icon: CircleSlash },
};

function StatePill({ state, size = "md" }) {
  const style = STATE_STYLE[state] || STATE_STYLE.unknown;
  const { Icon } = style;
  return (
    <span className={`inline-flex items-center gap-1 font-bold ${style.className} ${size === "md" ? "text-xs" : "text-[10px]"}`}>
      <Icon size={size === "md" ? 13 : 10} aria-hidden="true" />
      {style.label}
    </span>
  );
}

function ServerCard({ server, checks, slowMs, facts }) {
  return (
    <div className="flex flex-col rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-bold text-neutral-100">{server.name}</h3>
          <p className="text-[11px] text-neutral-500">{server.role}</p>
        </div>
        <StatePill state={server.state} />
      </div>
      <div className="divide-y divide-white/5">
        {checks.map((check) => (
          <CheckRow key={check.id} check={check} slowMs={slowMs} />
        ))}
      </div>
      <div className="mt-auto border-t border-white/5 pt-1">
        <Facts rows={facts} />
      </div>
    </div>
  );
}

function CheckRow({ check, slowMs }) {
  const off = check.state === "off";
  const down = check.state === "down";
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 py-2.5 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-bold text-neutral-200">
          {check.name}
          {down || off ? <StatePill state={check.state} size="sm" /> : null}
        </div>
        <div className={`truncate text-[11px] ${down ? "text-ops-red/80" : "text-neutral-500"}`}>
          {down ? check.last_error || "No answer" : check.detail}
        </div>
      </div>
      {off ? <span className="hidden sm:block" /> : <Spark values={check.recent || []} slowMs={slowMs} />}
      <div className="w-36 text-right">
        <div
          className={`text-sm font-bold tabular-nums ${
            check.state === "slow" ? "text-amber-200" : down ? "text-ops-red" : "text-neutral-100"
          }`}
        >
          {off ? "–" : down ? "No answer" : ms(check.last_ms)}
        </div>
        {!off && check.typical_ms !== null && check.typical_ms !== undefined ? (
          <div className="whitespace-nowrap text-[10px] text-neutral-500 tabular-nums">
            usually {ms(check.typical_ms)} · {formatRate(check.up_pct)}% up
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The last few checks as small bars: taller is slower, red is no answer. */
function Spark({ values, slowMs }) {
  const shown = values.slice(-30);
  const max = Math.max(slowMs / 4, ...shown.filter((value) => value !== null));
  return (
    // Fixed-width bars filling from the right, so a few checks look like a few.
    <div className="hidden h-6 w-[89px] items-end justify-end gap-px sm:flex" aria-hidden="true">
      {shown.map((value, index) => (
        <span
          key={index}
          className={`w-[2px] shrink-0 rounded-[1px] ${
            value === null ? "bg-ops-red" : value > slowMs ? "bg-amber-400" : ""
          }`}
          style={{
            height: value === null ? "100%" : `${Math.max(8, (value / max) * 100)}%`,
            background: value !== null && value <= slowMs ? ON_TIME : undefined,
          }}
        />
      ))}
    </div>
  );
}

function ms(value) {
  if (value === null || value === undefined) return "–";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}

/* ---------- pieces ---------- */

function Tile({ label, value, hint, tone }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] px-4 py-3.5">
      <div className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">{label}</div>
      <div className="mt-1 text-[28px] font-bold leading-tight tracking-tight text-neutral-100 tabular-nums">{value}</div>
      <div className={`mt-0.5 flex items-center gap-1 text-[11px] ${tone === "warn" ? "text-amber-200" : "text-neutral-500"}`}>
        {tone === "warn" ? <AlertTriangle size={11} /> : null}
        {hint}
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <h2 className="mb-2 mt-8 text-xs font-bold uppercase tracking-wide text-neutral-400">{children}</h2>;
}

function Card({ title, children }) {
  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
      <h3 className="mb-3 text-xs font-bold text-neutral-200">{title}</h3>
      {children}
    </div>
  );
}

function Facts({ rows }) {
  return (
    <dl className="divide-y divide-white/5 text-[11px]">
      {rows.map(([label, value], index) => (
        <div key={index} className="flex items-baseline justify-between gap-4 py-1.5">
          <dt className="min-w-0 truncate text-neutral-400">{label}</dt>
          <dd className="shrink-0 text-right font-bold text-neutral-200 tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Mini({ label, value }) {
  return (
    <div>
      <div className="text-base font-bold text-neutral-100 tabular-nums">{value.toLocaleString()}</div>
      <div className="text-[10px] text-neutral-500">{label}</div>
    </div>
  );
}

function Empty({ children }) {
  return <p className="py-4 text-center text-[11px] text-neutral-600">{children}</p>;
}

function CheckIcon({ state }) {
  if (state === "ok") return <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-ops-green" aria-label="Pass" />;
  if (state === "bad") return <XCircle size={15} className="mt-0.5 shrink-0 text-ops-red" aria-label="Fail" />;
  return <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-300" aria-label="Weak" />;
}

/** One thing that can fail: how often it worked, and whether it is up now. */
function LineRow({ line }) {
  const total = line.good + line.bad;
  const rate = total ? (line.good / total) * 100 : null;
  const off = line.live === "off";
  const down = line.live === "down";
  // Below 99% is worth a look; below 95% is a problem. Shown as text and an
  // icon as well, so the colour is never the only signal.
  const level = rate === null ? "none" : rate >= 99 ? "ok" : rate >= 95 ? "warn" : "bad";
  const barColor = { ok: "bg-ops-green", warn: "bg-amber-400", bad: "bg-ops-red", none: "bg-white/10" }[level];

  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-white/5 px-4 py-3 last:border-0">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-xs font-bold text-neutral-200">
          {line.name}
          {down ? (
            <span className="inline-flex items-center gap-1 rounded border border-ops-red/40 bg-red-500/10 px-1.5 py-px text-[9px] text-ops-red">
              <XCircle size={9} /> Down now
            </span>
          ) : line.live === "up" ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold text-ops-green">
              <ShieldCheck size={9} /> Up
            </span>
          ) : off ? (
            <span className="inline-flex items-center gap-1 text-[9px] font-bold text-neutral-500">
              <CircleSlash size={9} /> Off
            </span>
          ) : null}
        </div>
        <div className="truncate text-[11px] text-neutral-500">{line.note || line.detail}</div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]" aria-hidden="true">
        <div className={`h-full rounded-full ${barColor} transition-[width] duration-300`} style={{ width: `${rate ?? 0}%` }} />
      </div>
      <div className="w-36 text-right">
        <div className="text-xs font-bold text-neutral-100 tabular-nums">
          {rate === null ? "No data yet" : `${formatRate(rate)}%`}
        </div>
        {total ? (
          <div className="text-[10px] text-neutral-500 tabular-nums">
            {line.bad ? `${line.bad.toLocaleString()} failed of ${total.toLocaleString()}` : `${total.toLocaleString()} without a failure`}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Bars over time. Hovering (or focusing) a column shows its numbers in the
 * line above the plot, so nothing has to be read off the axis.
 */
function StackedBars({ points, unit, empty }) {
  const [active, setActive] = useState(null);
  const totals = points.map((point) => point.parts.reduce((sum, part) => sum + part.value, 0));
  const max = Math.max(...totals, 0);
  if (!max) return <Empty>{empty}</Empty>;

  const top = niceCeil(max);
  const shown = active ?? points.length - 1;
  const labelEvery = Math.ceil(points.length / 8);
  const legend = points[0].parts;

  return (
    <div>
      <div className="mb-2 flex min-h-[18px] flex-wrap items-baseline gap-x-3 text-[11px]">
        <span className="font-bold text-neutral-200">{tickLabel(points[shown].t, unit, true)}</span>
        {points[shown].parts.map((part) => (
          <span key={part.label} className="text-neutral-400">
            <span className="mr-1 inline-block h-2 w-2 rounded-sm align-baseline" style={{ background: part.color }} />
            {part.label} <span className="font-bold text-neutral-200 tabular-nums">{part.value}</span>
          </span>
        ))}
      </div>
      <div className="relative h-36" onMouseLeave={() => setActive(null)}>
        <span className="absolute -top-1 left-0 text-[9px] text-neutral-600 tabular-nums">{top}</span>
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-white/[0.07]" />
        <div className="absolute inset-0 flex items-end gap-[2px] border-b border-white/10">
          {points.map((point, index) => (
            <button
              key={point.t}
              type="button"
              aria-label={`${tickLabel(point.t, unit, true)}: ${point.parts.map((part) => `${part.label} ${part.value}`).join(", ")}`}
              onMouseEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className={`flex h-full min-w-0 flex-1 flex-col-reverse gap-[2px] rounded-sm outline-none transition-colors ${
                active === index ? "bg-white/[0.06]" : "focus-visible:bg-white/[0.06]"
              }`}
            >
              {point.parts.map((part, partIndex) =>
                part.value ? (
                  <span
                    key={part.label}
                    className={`mx-auto block w-full max-w-[28px] ${
                      // Rounded only on the end furthest from the baseline.
                      partIndex === lastFilled(point.parts) ? "rounded-t-[3px]" : ""
                    }`}
                    style={{ height: `${(part.value / top) * 100}%`, background: part.color }}
                  />
                ) : null,
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 flex gap-[2px] text-[9px] text-neutral-600">
        {points.map((point, index) => (
          <span key={point.t} className="min-w-0 flex-1 overflow-visible whitespace-nowrap text-center">
            {index % labelEvery === 0 ? tickLabel(point.t, unit) : ""}
          </span>
        ))}
      </div>
      {legend.length > 1 ? (
        <div className="mt-2 flex flex-wrap gap-x-4 text-[10px] text-neutral-500">
          {legend.map((part) => (
            <span key={part.label}>
              <span className="mr-1 inline-block h-2 w-2 rounded-sm" style={{ background: part.color }} />
              {part.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="animate-pulse" aria-busy="true" aria-label="Loading">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((item) => (
          <div key={item} className="h-[92px] rounded-lg border border-white/10 bg-white/[0.03]" />
        ))}
      </div>
      <div className="mt-12 grid gap-3 lg:grid-cols-2">
        <div className="h-64 rounded-lg border border-white/10 bg-white/[0.03]" />
        <div className="h-64 rounded-lg border border-white/10 bg-white/[0.03]" />
      </div>
      <div className="mt-12 h-80 rounded-lg border border-white/10 bg-white/[0.03]" />
    </div>
  );
}

/* ---------- formatting ---------- */

function lastFilled(parts) {
  for (let index = parts.length - 1; index >= 0; index -= 1) if (parts[index].value) return index;
  return -1;
}

function niceCeil(value) {
  if (value <= 5) return Math.max(1, value);
  const magnitude = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((step) => step * magnitude).find((step) => step >= value);
}

// The server sends wall-clock time in Lagos ("2026-11-11T15:00"), so it is read
// as written rather than shifted into the viewer's own zone.
function tickLabel(t, unit, long = false) {
  const [date, time] = t.split("T");
  const [year, month, day] = date.split("-").map(Number);
  const monthName = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString([], { month: "short", timeZone: "UTC" });
  if (unit === "hour") return long ? `${day} ${monthName}, ${time}` : time.slice(0, 2);
  return `${day} ${monthName}`;
}

function pct(part, total) {
  return total ? Math.round((part / total) * 100) : null;
}

function formatRate(rate) {
  if (rate === 100) return "100";
  return rate >= 99 ? rate.toFixed(2) : rate.toFixed(1);
}

function fraction(part, total) {
  return total ? `${part} of ${total}` : "–";
}

function flagged(value) {
  return value ? value : "None";
}

function viaText(value, sos) {
  // Alarms stored before this was recorded have no path at all.
  return sos.via_push + sos.via_poll ? value : "Not recorded yet";
}

function duration(seconds) {
  if (seconds === null || seconds === undefined) return "–";
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  if (seconds < 60) return `${Math.round(seconds)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
  return `${Math.round(seconds / 86_400)} days`;
}
