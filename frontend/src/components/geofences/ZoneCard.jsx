import { Pencil, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { LEVEL_STYLES } from "../../lib/alarm-levels";
import { formatDistance, insideZone, metresBetween } from "../../lib/fence-placement";
import { zoneColour } from "../../lib/zone-colours";
import { TRIGGER_LABEL, TRIGGER_LOOK, cardsFromRules, savedKey, targetsSummary, zoneKind } from "./zone-model";

/** "Covers Barnawa, about 1.2 km across. 8 radios inside now." */
export function zoneSummary(zone, ready, where, radios) {
  if (!ready) return null;
  let across = Number(zone.radius_m) * 2;
  if (zone.shape_type === "polygon") {
    const lats = zone.points.map(([, lat]) => lat);
    const lons = zone.points.map(([lon]) => lon);
    const south = Math.min(...lats);
    const west = Math.min(...lons);
    across = Math.max(
      metresBetween({ lat: south, lon: west }, { lat: Math.max(...lats), lon: west }),
      metresBetween({ lat: south, lon: west }, { lat: south, lon: Math.max(...lons) }),
    );
  }
  const inside = radios.filter((radio) => insideZone(radio, zone)).length;
  const size = zone.shape_type === "circle" ? `${formatDistance(Number(zone.radius_m))} radius` : `about ${formatDistance(across)} across`;
  const first = where ? `Covers ${where}, ${size}.` : `${size[0].toUpperCase()}${size.slice(1)}.`;
  const count = inside ? `${inside} radio${inside === 1 ? "" : "s"} inside now.` : "No radios inside now.";
  return `${first} ${count}`;
}

export function ZoneCard({ zone, index, canManage, onFocus, onEdit, onDelete }) {
  // A radio past the Red step is also past Amber and Yellow; counting the
  // nearest step alone counts each radio once.
  const cards = useMemo(() => {
    const breachById = new Map(zone.rules.map((rule) => [rule.id, Number(rule.in_breach) || 0]));
    return cardsFromRules(zone.rules).map((card) => ({
      ...card,
      outside: card.targets.reduce((sum, target) => sum + (breachById.get(card.saved[savedKey(target, card.trigger, card.steps[0].level)]) || 0), 0),
    }));
  }, [zone.rules]);
  const breached = cards.reduce((sum, card) => sum + card.outside, 0);
  const kind = zoneKind(zone.rules);
  const kinds = [...new Set(cards.map((card) => card.trigger))].filter((trigger) => TRIGGER_LOOK[trigger]);
  return (
    <article
      className="group rounded-lg border border-l-2 border-white/10 bg-white/[0.02] p-3 transition-colors hover:border-white/20"
      style={{ borderLeftColor: zoneColour(zone) }}
    >
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left" onClick={onFocus} title="Show on map" type="button">
          <span className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: zoneColour(zone) }} />
            <span className="truncate text-[12px] font-bold text-neutral-100">{zone.name}</span>
            {breached ? (
              <span className="shrink-0 rounded-full bg-red-500/15 px-1.5 py-0.5 text-[9px] font-bold text-red-300">
                {breached} {kind ? TRIGGER_LOOK[kind].breach : "in breach"}
              </span>
            ) : null}
          </span>
          {kinds.length ? (
            <span className="mt-1 flex flex-wrap gap-1">
              {kinds.map((trigger) => {
                const look = TRIGGER_LOOK[trigger];
                return (
                  <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[9px] font-bold ${look.chip}`} key={trigger}>
                    <look.Icon size={9} /> {look.zone}
                  </span>
                );
              })}
            </span>
          ) : null}
          <span className="mt-0.5 block text-[9px] text-neutral-600">
            {zone.shape_type === "circle" ? `Circle · ${formatDistance(Number(zone.radius_m))} radius` : "Shape"}
          </span>
        </button>
        {canManage ? (
          <div className="flex shrink-0 gap-0.5 opacity-70 transition-opacity group-hover:opacity-100">
            <button aria-label={`Edit ${zone.name}`} className="rounded p-1.5 text-neutral-400 hover:bg-white/5 hover:text-neutral-100" onClick={onEdit} type="button">
              <Pencil size={13} />
            </button>
            <button aria-label={`Delete ${zone.name}`} className="rounded p-1.5 text-neutral-400 hover:bg-red-500/10 hover:text-red-300" onClick={onDelete} type="button">
              <Trash2 size={13} />
            </button>
          </div>
        ) : null}
      </div>
      {zone.rules.length ? (
        <ul className="mt-2 space-y-1">
          {cards.map((card) => (
            <li className={`flex items-center gap-2 text-[10px] ${card.active ? "text-neutral-400" : "text-neutral-600 line-through"}`} key={card.key}>
              <span className="flex shrink-0 gap-0.5" title={card.steps.map((step) => LEVEL_STYLES[step.level].label).join(" → ")}>
                {card.steps.map((step) => (
                  <span className="h-2 w-2 rounded-full" key={step.level} style={{ background: LEVEL_STYLES[step.level].dot }} />
                ))}
              </span>
              {(() => {
                const look = TRIGGER_LOOK[card.trigger];
                return look ? <look.Icon className={`shrink-0 ${look.icon}`} size={10} /> : null;
              })()}
              <span className="truncate">
                <span className="font-bold text-neutral-300">{targetsSummary(index, card.targets, 3)}</span> {TRIGGER_LABEL[card.trigger]}
              </span>
              {card.outside ? <span className="ml-auto shrink-0 font-bold text-red-300">{card.outside}</span> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[10px] text-neutral-600">No rules: watches nobody.</p>
      )}
    </article>
  );
}
