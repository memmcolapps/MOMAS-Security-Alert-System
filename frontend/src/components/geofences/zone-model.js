import { Ban, LogOut } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { LEVELS } from "../../lib/alarm-levels";

// A zone is only a place. Each rule on it says who it watches, whether leaving
// or entering is the problem, and how loud the alarm is.
export const EMPTY_ZONE = {
  id: null,
  organization_id: "",
  name: "",
  shape_type: "circle",
  points: [],
  center_lat: null,
  center_lon: null,
  radius_m: 300,
};

// In the editor a rule card holds any number of radios, plus units or
// channels as a shortcut, and one direction. Its alarm comes in steps that get
// louder further from the edge: Yellow at the edge, Amber 200 m out, Red 500 m
// out. On save it becomes one stored rule per radio and step, so each radio
// still alarms on its own and the server knows each step's line.
export let ruleSeq = 0;
export function newRule(patch = {}) {
  ruleSeq += 1;
  return {
    key: `new-${ruleSeq}`,
    targets: [],
    trigger: "exit",
    steps: [firstStep(patch.trigger || "exit")],
    confirmations_required: 1,
    active: true,
    saved: {},
    ...patch,
  };
}

export const LEVEL_RANK = { yellow: 0, amber: 1, red: 2 };
export const MAX_STEP_M = 20_000;

// Steps are listed from the edge outwards. Going out, a keep-in zone's steps
// get louder (a radio further away is more lost); a no-go zone's get quieter
// (a radio further away is less of a worry), so Red sits at its edge.
export const outwardRank = (trigger, level) => (trigger === "enter" ? -LEVEL_RANK[level] : LEVEL_RANK[level]);
export const OUTWARD_LEVELS = {
  exit: [...LEVELS].sort((a, b) => outwardRank("exit", a) - outwardRank("exit", b)),
  enter: [...LEVELS].sort((a, b) => outwardRank("enter", a) - outwardRank("enter", b)),
};
export const levelsOutward = (trigger) => OUTWARD_LEVELS[trigger] || OUTWARD_LEVELS.exit;

/**
 * The step at the edge. A keep-in zone's is held 30 m out, off GPS drift; a
 * no-go zone's is the edge itself, since being inside is the alarm.
 */
export function firstStep(trigger) {
  return trigger === "enter" ? { level: "red", distance_m: 0 } : { level: "amber", distance_m: 30 };
}

/** Keeps only steps in the right order going out; anything that no longer is, is dropped. */
export function keepInOrder(steps, trigger) {
  const kept = [];
  for (const step of steps) {
    const previous = kept[kept.length - 1];
    if (!previous || outwardRank(trigger, step.level) > outwardRank(trigger, previous.level)) kept.push(step);
  }
  return kept;
}

/** The next step out and a sensible distance for it. */
export function nextStep(steps, trigger) {
  const last = steps[steps.length - 1];
  const level = levelsOutward(trigger).find((item) => outwardRank(trigger, item) > outwardRank(trigger, last.level));
  if (!level) return null;
  // Measured from the zone's edge, so small steps: 100 m, then 250 m.
  const distance = Number(last.distance_m) < 100 ? 100 : Math.round((Number(last.distance_m) * 2.5) / 50) * 50;
  return { level, distance_m: Math.min(MAX_STEP_M, distance) };
}

/**
 * Switching a card between "must stay inside" and "must not enter" keeps its
 * distances and turns the levels round: Yellow, Amber, Red out from a keep-in
 * edge becomes Red, Amber, Yellow out from a no-go edge.
 */
export function stepsForTrigger(steps, from, to) {
  if (from === to) return steps;
  return steps.map((step, index) => ({
    level: steps[steps.length - 1 - index].level,
    distance_m: index === 0 && Number(step.distance_m) === firstStep(from).distance_m ? firstStep(to).distance_m : step.distance_m,
  }));
}

export const savedKey = (target, trigger, level) => `${target.target_type}:${target.target_id}:${trigger}:${level}`;

export const TRIGGER_LABEL = { exit: "must stay inside", enter: "must not enter" };

// Leaving and entering look different everywhere a zone is listed or drawn:
// a blue keep-in zone, a rose no-go zone with a dashed edge.
export const TRIGGER_LOOK = {
  exit: {
    zone: "Keep-in zone",
    Icon: LogOut,
    chip: "border-sky-400/40 bg-sky-400/10 text-sky-300",
    accent: "border-l-sky-400",
    icon: "text-sky-300",
    breach: "outside",
    stroke: "#38bdf8",
    dash: null,
  },
  enter: {
    zone: "No-go zone",
    Icon: Ban,
    chip: "border-rose-400/40 bg-rose-400/10 text-rose-300",
    accent: "border-l-rose-400",
    icon: "text-rose-300",
    breach: "inside",
    stroke: "#fb7185",
    dash: "6 5",
  },
};

/** "exit", "enter", or null for a zone with both kinds of rule (or none). */
export function zoneKind(rules) {
  const triggers = new Set((rules || []).map((rule) => rule.trigger));
  return triggers.size === 1 ? [...triggers][0] : null;
}
export const AROUND_MARGIN_M = 150;

// The same basemaps as the operations map, so a zone is drawn on exactly what
// operators will see it on.
export const BASEMAPS = {
  satellite: { label: "Satellite" },
  streets: { label: "Streets" },
  grey: { label: "Grey" },
};

export const MEMBER_COLOURS = { ok: "#22c55e", breach: "#ef4444", unknown: "#94a3b8", pending: "#38bdf8" };

export function samePoint(a, b) {
  return a && b && Number(a[0]) === Number(b[0]) && Number(a[1]) === Number(b[1]);
}

export function toForm(zone) {
  const ring = zone.geometry?.coordinates?.[0] || [];
  const points = ring.length > 1 && samePoint(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring;
  return {
    zone: {
      id: zone.id,
      organization_id: String(zone.organization_id || ""),
      name: zone.name || "",
      shape_type: zone.shape_type,
      points,
      center_lat: zone.center_lat == null ? null : Number(zone.center_lat),
      center_lon: zone.center_lon == null ? null : Number(zone.center_lon),
      radius_m: Number(zone.radius_m) || 300,
    },
    rules: cardsFromRules(zone.rules || []),
  };
}

/**
 * Stored rules back into cards: each radio's rules on one direction are its
 * steps, and radios with exactly the same steps share a card.
 */
export function cardsFromRules(rules) {
  const perTarget = new Map();
  for (const rule of rules) {
    const target = { target_type: rule.target_type, target_id: String(rule.target_id) };
    const tuning = [Number(rule.confirmations_required), rule.active !== false];
    const key = [target.target_type, target.target_id, rule.trigger, ...tuning].join("|");
    if (!perTarget.has(key)) {
      perTarget.set(key, { target, trigger: rule.trigger, tuning, steps: [], saved: {} });
    }
    const entry = perTarget.get(key);
    entry.steps.push({ level: LEVELS.includes(rule.level) ? rule.level : "red", distance_m: Number(rule.buffer_m) || 0 });
    entry.saved[savedKey(target, rule.trigger, rule.level)] = rule.id;
  }
  const cards = new Map();
  for (const entry of perTarget.values()) {
    const steps = keepInOrder(
      [...entry.steps].sort((a, b) => a.distance_m - b.distance_m || outwardRank(entry.trigger, a.level) - outwardRank(entry.trigger, b.level)),
      entry.trigger,
    );
    const signature = [entry.trigger, ...entry.tuning, steps.map((step) => `${step.level}@${step.distance_m}`).join(",")].join("|");
    const card = cards.get(signature);
    if (card) {
      card.targets.push(entry.target);
      Object.assign(card.saved, entry.saved);
      continue;
    }
    cards.set(signature, {
      key: `rule-${Object.values(entry.saved)[0]}`,
      targets: [entry.target],
      trigger: entry.trigger,
      steps,
      confirmations_required: entry.tuning[0],
      active: entry.tuning[1],
      saved: { ...entry.saved },
    });
  }
  return [...cards.values()];
}

/**
 * One stored rule per radio and step. A step keeps its stored rule while its
 * radio, direction and level stay the same; anything else is a new rule, so the
 * server starts it fresh instead of carrying an old breach state over.
 */
export function expandRule(card) {
  return card.targets.flatMap((target) =>
    card.steps.map((step, stepIndex) => {
      const id = card.saved?.[savedKey(target, card.trigger, step.level)] || null;
      return {
        cardKey: card.key,
        stepIndex,
        level: step.level,
        fresh: !id,
        payload: {
          id,
          target_type: target.target_type,
          target_id: target.target_id,
          trigger: card.trigger,
          level: step.level,
          buffer_m: Number(step.distance_m),
          confirmations_required: Number(card.confirmations_required),
          active: card.active,
        },
      };
    }),
  );
}

export const hasTarget = (card, type, id) => card.targets.some((t) => t.target_type === type && String(t.target_id) === String(id));

export function isPlaced(zone) {
  return zone.shape_type === "polygon" ? zone.points.length >= 3 : zone.center_lat != null && Number(zone.radius_m) > 0;
}

export function toGeometry(zone) {
  if (zone.shape_type !== "polygon" || zone.points.length < 3) return null;
  return { type: "Polygon", coordinates: [[...zone.points, zone.points[0]]] };
}

export function zonePayload(zone) {
  return {
    name: zone.name,
    shape_type: zone.shape_type,
    geometry: toGeometry(zone),
    center_lat: zone.center_lat,
    center_lon: zone.center_lon,
    radius_m: zone.shape_type === "circle" ? Number(zone.radius_m) : null,
  };
}

/** Holds a value back until it has stopped changing, so dragging a corner sends one preview. */
export function useSettled(value, delayMs) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** Name lookups and member lists for everything a rule can point at, across organizations. */
export function useTargetIndex(allTargets) {
  return useMemo(() => {
    const names = new Map();
    const members = new Map();
    for (const targets of allTargets) {
    for (const unit of targets?.units || []) {
      names.set(`unit:${unit.id}`, unit.name);
      members.set(`unit:${unit.id}`, unit.members || []);
    }
    for (const channel of targets?.channels || []) {
      names.set(`channel:${channel.id}`, channel.name);
      members.set(`channel:${channel.id}`, channel.members || []);
    }
    for (const radio of targets?.radios || []) {
      const key = `radio:${radio.device_id}`;
      names.set(key, radio.name || `Radio ${radio.device_id}`);
      members.set(key, [key]);
    }
    for (const drone of targets?.drones || []) {
      const key = `drone:${drone.sysid}`;
      names.set(key, drone.name || `Drone ${drone.sysid}`);
      members.set(key, [key]);
    }
    }
    return { names, members };
  }, [allTargets]);
}

export function targetLabel(index, target) {
  const key = `${target.target_type}:${target.target_id}`;
  const name = index.names.get(key) || `${target.target_type} ${target.target_id}`;
  return target.target_type === "unit" || target.target_type === "channel" ? `${name} (all)` : name;
}

/** "Bello, Musa +3" — enough to recognise a card without reading every chip. */
export function targetsSummary(index, targets, max = 2) {
  if (!targets.length) return "Nobody yet";
  const names = targets.slice(0, max).map((target) => targetLabel(index, target)).join(", ");
  return targets.length > max ? `${names} +${targets.length - max}` : names;
}
