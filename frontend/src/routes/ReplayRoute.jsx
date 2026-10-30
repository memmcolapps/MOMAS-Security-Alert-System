import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { replayRange } from "../components/ReplayPanel";
import { ReplayFleetPanel } from "../components/ReplayFleetPanel";
import { ReplayMap } from "../components/ReplayMap";
import { REPLAY_SPEEDS, ReplayTimeline } from "../components/ReplayTimeline";
import { getFleetReplay, listDevices } from "../lib/api";
import { activityBins, buildFleetReplay, naturalSpeed, nextBusyTime } from "../lib/fleet-replay";

// A skip shorter than this is just the gap between two trips; not worth a notice.
const SKIP_NOTICE_MS = 10 * 60_000;

/**
 * The Replay tab: every radio that moved in a window, played back together on
 * one clock. The list says who moved and what each is doing right now in the
 * replay; the timeline shows when the fleet was busy; picking a radio tells
 * its own story of trips and stops.
 */
export function ReplayRoute() {
  const [windowChoice, setWindowChoice] = useState("4h");
  // Fixed when picked, so "the last hour" does not slide while it is watched.
  const [range, setRange] = useState(() => replayRange("4h"));
  const [time, setTime] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(120);
  const [skipQuiet, setSkipQuiet] = useState(true);
  const [skipped, setSkipped] = useState(0);
  const [trailMode, setTrailMode] = useState("full");
  const [focusId, setFocusId] = useState(null);
  const [follow, setFollow] = useState(false);
  const [hiddenIds, setHiddenIds] = useState(() => new Set());
  const [showStill, setShowStill] = useState(false);
  const [panTarget, setPanTarget] = useState(null);

  const devicesQuery = useQuery({ queryKey: ["devices"], queryFn: listDevices, staleTime: 60_000 });
  const replayQuery = useQuery({
    queryKey: ["fleet-replay", range.from, range.to],
    queryFn: () => getFleetReplay(range.from, range.to),
    staleTime: Infinity,
  });

  const registry = useMemo(
    () => new Map((devicesQuery.data?.devices || []).map((device) => [String(device.device_id), device])),
    [devicesQuery.data],
  );
  const names = useCallback((uid) => registry.get(uid)?.name || `Radio ${uid}`, [registry]);
  const units = useCallback(
    (uid) => {
      const device = registry.get(uid);
      return [device?.unit_name, device?.organization_name].filter(Boolean).join(" · ");
    },
    [registry],
  );

  const fleet = useMemo(() => (replayQuery.data ? buildFleetReplay(replayQuery.data) : null), [replayQuery.data]);
  const focused = fleet && focusId ? fleet.movers.find((radio) => radio.uid === focusId) || null : null;
  const notHeard = useMemo(() => {
    if (!fleet || !registry.size) return 0;
    const heard = new Set([...fleet.movers, ...fleet.still].map((radio) => radio.uid));
    return [...registry.values()].filter((device) => device.active !== false && !heard.has(String(device.device_id))).length;
  }, [fleet, registry]);

  // A new window starts paused just before the first movement, at a speed that
  // plays it in a couple of minutes.
  useEffect(() => {
    if (!fleet) return;
    setPlaying(false);
    setFocusId(null);
    setFollow(false);
    setSkipped(0);
    setSpeed(naturalSpeed(fleet.to - fleet.from, REPLAY_SPEEDS));
    const first = nextBusyTime(fleet.bins, fleet.from);
    setTime(first != null ? Math.max(fleet.from, first - 60_000) : fleet.from);
  }, [fleet]);

  // What counts as "quiet": nobody moving, or with a radio picked, that radio
  // not moving.
  const quietBins = useMemo(() => (focused ? activityBins([focused], fleet.from, fleet.to) : fleet?.bins), [fleet, focused]);

  const timeRef = useRef(time);
  timeRef.current = time;
  useEffect(() => {
    if (!playing || !fleet) return undefined;
    let last = window.performance.now();
    let frame = null;
    const step = (stamp) => {
      let next = Math.min(fleet.to, (timeRef.current ?? fleet.from) + (stamp - last) * speed);
      last = stamp;
      if (skipQuiet) {
        const busy = nextBusyTime(quietBins, next);
        if (busy == null) next = fleet.to;
        else if (busy > next) {
          if (busy - next >= SKIP_NOTICE_MS) setSkipped(busy - next);
          next = busy;
        }
      }
      timeRef.current = next;
      setTime(next);
      if (next >= fleet.to) setPlaying(false);
      else frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, speed, fleet, skipQuiet, quietBins]);

  useEffect(() => {
    if (!skipped) return undefined;
    const timer = window.setTimeout(() => setSkipped(0), 2500);
    return () => window.clearTimeout(timer);
  }, [skipped]);

  const play = useCallback(
    (value) => {
      if (value && fleet && (timeRef.current ?? fleet.to) >= fleet.to) setTime(fleet.from);
      setPlaying(value);
    },
    [fleet],
  );
  const seek = useCallback(
    (t) => {
      if (!fleet) return;
      setTime(Math.min(fleet.to, Math.max(fleet.from, t)));
    },
    [fleet],
  );

  useEffect(() => {
    const onKey = (event) => {
      if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
      if (event.key === " ") {
        event.preventDefault();
        play(!playing);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const delta = (event.shiftKey ? 10 : 1) * 60_000 * (event.key === "ArrowLeft" ? -1 : 1);
        seek((timeRef.current ?? 0) + delta);
      } else if (event.key === "Escape") {
        setFocusId(null);
        setFollow(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [play, playing, seek]);

  const chooseWindow = (choice) => {
    setWindowChoice(choice);
    if (choice !== "custom") setRange(replayRange(choice));
  };

  const focus = useCallback((uid) => {
    setFocusId(uid);
    if (!uid) setFollow(false);
    if (uid)
      setHiddenIds((current) => {
        if (!current.has(uid)) return current;
        const next = new Set(current);
        next.delete(uid);
        return next;
      });
  }, []);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-ops-bg text-neutral-200">
      <ReplayMap
        fleet={fleet}
        time={time}
        focusId={focusId}
        trailMode={trailMode}
        hiddenIds={hiddenIds}
        showStill={showStill}
        follow={follow}
        names={names}
        onFocus={focus}
        panTarget={panTarget}
      />
      <ReplayFleetPanel
        windowChoice={windowChoice}
        onWindow={chooseWindow}
        onCustomWindow={setRange}
        onRefresh={() => setRange(replayRange(windowChoice))}
        relative={["1h", "4h", "12h", "today"].includes(windowChoice)}
        fleet={fleet}
        loading={replayQuery.isLoading}
        error={replayQuery.error?.message}
        time={time ?? fleet?.from ?? 0}
        onTime={seek}
        focusId={focusId}
        onFocus={focus}
        follow={follow}
        onFollow={setFollow}
        hiddenIds={hiddenIds}
        onToggleHidden={(uid) =>
          setHiddenIds((current) => {
            const next = new Set(current);
            if (next.has(uid)) next.delete(uid);
            else next.add(uid);
            return next;
          })
        }
        showStill={showStill}
        onShowStill={setShowStill}
        onPan={setPanTarget}
        names={names}
        units={units}
        notHeard={notHeard}
      />
      {fleet && time != null ? (
        <ReplayTimeline
          fleet={fleet}
          time={time}
          onTime={seek}
          playing={playing}
          onPlaying={play}
          speed={speed}
          onSpeed={setSpeed}
          skipQuiet={skipQuiet}
          onSkipQuiet={setSkipQuiet}
          trailMode={trailMode}
          onTrailMode={setTrailMode}
          focused={focused}
          skipped={skipped}
        />
      ) : null}
    </main>
  );
}
