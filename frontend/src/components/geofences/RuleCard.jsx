import { Check, ChevronDown, Plus, Radio, Search, Settings2, Trash2, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { LEVEL_MEANING, LEVEL_STYLES } from "../../lib/alarm-levels";
import { LEVEL_RANK, MAX_STEP_M, hasTarget, keepInOrder, levelsOutward, nextStep, outwardRank, stepsForTrigger, targetLabel } from "./zone-model";

/**
 * Pick radios one by one, ticking as many as needed; the list stays open.
 * Units and channels sit underneath as a shortcut for "all of them".
 */
export function TargetPicker({ rule, targets, onToggle }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event) => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const needle = query.trim().toLowerCase();
  const match = (name, id) => !needle || String(name || "").toLowerCase().includes(needle) || String(id).toLowerCase().includes(needle);
  const groups = [
    {
      title: "Radios",
      items: (targets?.radios || []).filter((r) => match(r.name, r.device_id)).map((r) => ({
        type: "radio", id: String(r.device_id), name: r.name || `Radio ${r.device_id}`, meta: r.device_id,
      })),
    },
    {
      title: "Drones",
      items: (targets?.drones || []).filter((d) => match(d.name, d.sysid)).map((d) => ({
        type: "drone", id: String(d.sysid), name: d.name || `Drone ${d.sysid}`, meta: `#${d.sysid}`,
      })),
    },
    {
      title: "Whole unit (includes radios added later)",
      items: (targets?.units || []).filter((u) => match(u.name, u.id)).map((u) => ({
        type: "unit", id: String(u.id), name: u.name, meta: `${u.members?.length || 0}`,
      })),
    },
    {
      title: "Whole channel (includes radios added later)",
      items: (targets?.channels || []).filter((c) => match(c.name, c.id)).map((c) => ({
        type: "channel", id: String(c.id), name: c.name, meta: `${c.members?.length || 0}`,
      })),
    },
  ].filter((group) => group.items.length);

  return (
    <div className="relative" ref={rootRef}>
      <button
        className={`flex w-full items-center gap-1.5 rounded-md border px-2.5 py-2 text-left text-[11px] font-bold transition-colors ${
          rule.targets.length
            ? "border-white/15 bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]"
            : "border-red-400/40 bg-red-500/[0.06] text-red-200 hover:bg-red-500/10"
        }`}
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <Plus size={12} />
        <span className="truncate">{rule.targets.length ? "Add or remove radios" : "Choose radios"}</span>
        <ChevronDown className="ml-auto shrink-0 text-neutral-500" size={12} />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-white/15 bg-[#0d0d0d] shadow-2xl">
          <div className="relative border-b border-white/10 p-2">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-neutral-600" size={12} />
            <input
              autoFocus
              className="field-input pl-7"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name or ID"
              value={query}
            />
          </div>
          <div className="max-h-72 overflow-y-auto py-1">
            {groups.map((group) => (
              <div key={group.title}>
                <div className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">{group.title}</div>
                {group.items.slice(0, needle ? 100 : 60).map((item) => {
                  const selected = hasTarget(rule, item.type, item.id);
                  return (
                    <button
                      aria-pressed={selected}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-white/5 ${selected ? "text-neutral-100" : "text-neutral-400"}`}
                      key={`${item.type}:${item.id}`}
                      onClick={() => onToggle(item.type, item.id)}
                      type="button"
                    >
                      <span
                        className={`grid h-3.5 w-3.5 shrink-0 place-items-center rounded border ${selected ? "border-red-400 bg-red-400 text-black" : "border-white/25"}`}
                      >
                        {selected ? <Check size={10} strokeWidth={3} /> : null}
                      </span>
                      <span className="truncate">{item.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[9px] text-neutral-600">{item.meta}</span>
                    </button>
                  );
                })}
              </div>
            ))}
            {!groups.length ? <p className="px-3 py-4 text-center text-[10px] text-neutral-600">Nothing matches.</p> : null}
          </div>
          <div className="border-t border-white/10 p-2">
            <button
              className="w-full rounded-md bg-red-400 px-3 py-1.5 text-[10px] font-bold text-black hover:opacity-90"
              onClick={() => setOpen(false)}
              type="button"
            >
              Done · {rule.targets.length} selected
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The chosen radios as removable chips; long lists fold behind "+N more". */
export function TargetChips({ rule, index, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  if (!rule.targets.length) return null;
  const shown = expanded ? rule.targets : rule.targets.slice(0, 8);
  return (
    <div className="mb-2 flex flex-wrap gap-1">
      {shown.map((target) => (
        <span
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-white/15 bg-white/[0.06] py-0.5 pl-2 pr-1 text-[10px] font-bold text-neutral-200"
          key={`${target.target_type}:${target.target_id}`}
        >
          {target.target_type === "unit" || target.target_type === "channel" ? <Users size={10} /> : <Radio size={10} />}
          <span className="truncate">{targetLabel(index, target)}</span>
          <button
            aria-label={`Remove ${targetLabel(index, target)}`}
            className="rounded-full p-0.5 text-neutral-500 hover:bg-white/10 hover:text-neutral-100"
            onClick={() => onToggle(target.target_type, target.target_id)}
            type="button"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      {rule.targets.length > 8 ? (
        <button className="px-1 text-[10px] font-bold text-neutral-500 hover:text-neutral-200" onClick={() => setExpanded((v) => !v)} type="button">
          {expanded ? "Show less" : `+${rule.targets.length - 8} more`}
        </button>
      ) : null}
    </div>
  );
}

export function verdictText(rule, verdict) {
  if (!rule.targets.length || !verdict) return null;
  const { summary, members } = verdict;
  if (!summary.total) return { tone: "text-neutral-500", text: "No radios in that group yet." };
  // A no-go zone's steps sit outside it, so a breach may be "too close", not yet in.
  const okWord = rule.trigger === "exit" ? "inside" : "clear";
  const breachWord = rule.trigger === "exit" ? "outside" : "too close";
  const breached = members.filter((member) => member.state === "breach");
  const parts = summary.ok || !breached.length ? [`${summary.ok} of ${summary.total} ${okWord}`] : [];
  if (breached.length) {
    const names = breached.slice(0, 2).map((member) => member.name).join(", ");
    const loudest = breached.reduce((top, member) => (LEVEL_RANK[member.level] > LEVEL_RANK[top] ? member.level : top), breached[0].level);
    const level = rule.steps.length > 1 && LEVEL_STYLES[loudest] ? ` (${LEVEL_STYLES[loudest].label})` : "";
    parts.push(`${names}${breached.length > 2 ? ` +${breached.length - 2}` : ""} ${breachWord}${level}`);
  }
  if (summary.unknown) parts.push(`${summary.unknown} not reporting`);
  return { tone: breached.length ? "text-amber-300" : "text-green-300", text: parts.join(" · ") };
}

/**
 * The alarm as steps out from the edge. Pick how loud it is at the edge, then
 * optionally more steps further out: louder for a keep-in zone, quieter early
 * warnings for a no-go zone.
 */
export function AlarmSteps({ rule, onChange }) {
  const order = levelsOutward(rule.trigger);
  const setSteps = (steps) => onChange({ steps: keepInOrder(steps, rule.trigger) });
  const update = (index, patch) => setSteps(rule.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const next = nextStep(rule.steps, rule.trigger);
  return (
    <div className="mt-2 space-y-1.5">
      {rule.steps.map((step, index) => {
        const previous = rule.steps[index - 1];
        const choices = previous ? order.filter((level) => outwardRank(rule.trigger, level) > outwardRank(rule.trigger, previous.level)) : order;
        return (
          <div className="rounded-md border border-white/10 bg-black/20 p-1.5" key={index}>
            <div className="flex items-center gap-1">
              {choices.map((level) => {
                const style = LEVEL_STYLES[level];
                const on = step.level === level;
                return (
                  <button
                    className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border px-2 py-1.5 text-[10px] font-bold transition-colors ${on ? style.chip : "border-white/10 text-neutral-500 hover:text-neutral-300"}`}
                    key={level}
                    onClick={() => update(index, { level })}
                    title={LEVEL_MEANING[level]}
                    type="button"
                  >
                    <span className="h-2 w-2 rounded-full" style={{ background: style.dot, opacity: on ? 1 : 0.5 }} />
                    {style.label}
                  </button>
                );
              })}
              {index ? (
                <button
                  aria-label="Remove this step"
                  className="rounded p-1.5 text-neutral-600 hover:bg-white/5 hover:text-neutral-200"
                  onClick={() => setSteps(rule.steps.filter((_, i) => i !== index))}
                  type="button"
                >
                  <X size={11} />
                </button>
              ) : null}
            </div>
            <div className="mt-1.5 flex items-center gap-1.5 px-0.5 text-[10px] text-neutral-400">
              <span>at</span>
              <input
                aria-label={`Distance for ${LEVEL_STYLES[step.level].label}`}
                className="field-input w-20 py-1 text-[10px]"
                max={MAX_STEP_M}
                min={index ? "1" : "0"}
                onChange={(event) => update(index, { distance_m: event.target.value })}
                type="number"
                value={step.distance_m}
              />
              <span>m outside the edge</span>
              <span className="ml-auto text-[9px] text-neutral-600">{LEVEL_MEANING[step.level]}</span>
            </div>
          </div>
        );
      })}
      {next ? (
        <button
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-white/15 px-2 py-1.5 text-[10px] font-bold text-neutral-400 hover:border-white/30 hover:text-neutral-200"
          onClick={() => setSteps([...rule.steps, next])}
          type="button"
        >
          <Plus size={11} /> {rule.trigger === "enter" ? "Warn earlier:" : "Then"} {LEVEL_STYLES[next.level].label} further out
        </button>
      ) : null}
    </div>
  );
}

export function RuleCard({ rule, targets, index, verdict, focused, onFocus, onChange, onToggle, onRemove, removable }) {
  const [advanced, setAdvanced] = useState(false);
  const status = verdictText(rule, verdict);
  return (
    <div
      className={`rounded-lg border p-2.5 transition-colors ${focused ? "border-white/25 bg-white/[0.04]" : "border-white/10 bg-white/[0.02]"}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      {removable ? (
        <div className="-mt-1 mb-1 flex justify-end">
          <button
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[9px] font-bold text-neutral-600 hover:bg-red-500/10 hover:text-red-300"
            onClick={onRemove}
            type="button"
          >
            <Trash2 size={10} /> Remove rule
          </button>
        </div>
      ) : null}
      <TargetChips index={index} onToggle={onToggle} rule={rule} />
      <TargetPicker onToggle={onToggle} rule={rule} targets={targets} />

      <div className="mt-2 grid grid-cols-2 gap-1 rounded-md bg-black/30 p-0.5">
        {["exit", "enter"].map((trigger) => (
          <button
            className={`rounded px-2 py-1.5 text-[10px] font-bold transition-colors ${rule.trigger === trigger ? "bg-white/[0.12] text-neutral-100 shadow-sm" : "text-neutral-500 hover:text-neutral-300"}`}
            key={trigger}
            onClick={() => onChange({ trigger, steps: stepsForTrigger(rule.steps, rule.trigger, trigger) })}
            type="button"
          >
            {trigger === "exit" ? "Must stay inside" : "Must not enter"}
          </button>
        ))}
      </div>

      <AlarmSteps rule={rule} onChange={onChange} />

      {status ? <p className={`mt-1.5 text-[10px] font-bold ${status.tone}`}>{status.text}</p> : null}

      <button
        className="mt-1.5 inline-flex items-center gap-1 text-[9px] font-bold text-neutral-600 hover:text-neutral-300"
        onClick={() => setAdvanced((value) => !value)}
        type="button"
      >
        <Settings2 size={10} /> Alarm settings
        <ChevronDown className={`transition-transform ${advanced ? "" : "-rotate-90"}`} size={10} />
      </button>
      {advanced ? (
        <div className="mt-2 space-y-2 rounded-md border border-white/10 bg-black/20 p-2">
          <div>
            <label className="block w-1/2 text-[9px] text-neutral-500">
              Readings before alarm
              <input
                className="field-input mt-1"
                max="10"
                min="1"
                onChange={(event) => onChange({ confirmations_required: event.target.value })}
                type="number"
                value={rule.confirmations_required}
              />
            </label>
          </div>
          <p className="text-[9px] leading-relaxed text-neutral-600">
            {Number(rule.confirmations_required) > 1
              ? `Each step alarms after ${rule.confirmations_required} readings in a row past its line, about ${Number(rule.confirmations_required) * 5} seconds for a radio.`
              : "Each step alarms on the first reading past its line. Raise this if GPS jitter sets off false alarms."}
          </p>
          <label className="flex items-center gap-2 text-[10px] text-neutral-400">
            <input checked={rule.active} onChange={(event) => onChange({ active: event.target.checked })} type="checkbox" />
            Rule switched on
          </label>
        </div>
      ) : null}
    </div>
  );
}
