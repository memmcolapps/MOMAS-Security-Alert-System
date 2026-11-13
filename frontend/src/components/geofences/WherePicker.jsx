import { useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, LocateFixed, MapPin, PenLine, Radio, Search, Users } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { getPlaceBorder, searchPlaces, suggestPlaces } from "../../lib/api";

/** Lives over the map, because all it does is move the view. */
export function PlaceSearch({ onPick }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      searchPlaces(query.trim())
        .then((data) => setResults(data.places || []))
        .catch(() => setResults([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query]);
  return (
    <div className="absolute left-3 top-3 z-[1001] w-[min(260px,calc(100%-24px))]">
      <div className="relative">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          aria-label="Search for a place"
          className="w-full rounded-lg border border-white/15 bg-black/70 py-2 pl-8 pr-3 text-[11px] text-neutral-200 shadow-lg outline-none backdrop-blur placeholder:text-neutral-500 focus:border-white/30"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find a town or state"
          value={query}
        />
      </div>
      {results.length ? (
        <ul className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-white/15 bg-[#0b0b0b]/95 py-1 shadow-xl backdrop-blur">
          {results.map((place) => (
            <li key={`${place.name}-${place.state}`}>
              <button
                className="block w-full px-3 py-1.5 text-left text-[11px] text-neutral-300 hover:bg-white/5"
                onClick={() => {
                  setQuery("");
                  setResults([]);
                  onPick(place);
                }}
                type="button"
              >
                {place.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// Sizes said the way people say them, by how wide the thing is from one side
// to the other. They used to be radii, so "Building" drew a circle 100 m
// across. A circle is one of these unless someone drags it to another size.
export const SIZES = [
  { label: "Building", across: 30 },
  { label: "Compound", across: 100 },
  { label: "Street block", across: 250 },
  { label: "Neighbourhood", across: 1000 },
  { label: "Town", across: 5000 },
].map((size) => ({ ...size, radius: size.across / 2 }));
export const MAX_RADIUS_M = 50_000;
export const DEFAULT_RADIUS = SIZES[1].radius;

/** A place with no outline gets a circle about as wide as its kind suggests. */
export function radiusForKind(kind) {
  if (["City", "Local government"].includes(kind)) return SIZES[4].radius;
  if (["Town", "Village", "Area", "Airport", "Military", "Barracks", "University"].includes(kind)) return SIZES[3].radius;
  return DEFAULT_RADIUS;
}

// How far "Bigger" pushes a place's own border out, a step at a time.
export const MARGINS = [0, 50, 100, 250, 500, 1000];

export const borderQuery = (osm) => ({
  queryKey: ["place-border", osm],
  queryFn: () => getPlaceBorder(osm),
  staleTime: Infinity,
});

/**
 * The one question for a new zone: where is it? Takes a place name, a radio's
 * name, or "my location", and works out the shape itself. Drawing by hand is
 * the other way in, right underneath.
 */
export function WherePicker({ radios, aroundCount, onPlace, onDraw, onAround }) {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [online, setOnline] = useState([]);
  const [local, setLocal] = useState([]);
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const needle = query.trim();

  useEffect(() => {
    if (needle.length < 2) {
      setLocal([]);
      setOnline([]);
      return undefined;
    }
    let stale = false;
    // The town list answers at once; OpenStreetMap follows with the borders.
    const fast = window.setTimeout(() => {
      searchPlaces(needle)
        .then((data) => !stale && setLocal(data.places || []))
        .catch(() => !stale && setLocal([]));
    }, 150);
    const slow = window.setTimeout(() => {
      if (needle.length < 3) return;
      suggestPlaces(needle)
        .then((data) => !stale && setOnline(data.places || []))
        .catch(() => !stale && setOnline([]));
    }, 350);
    return () => {
      stale = true;
      window.clearTimeout(fast);
      window.clearTimeout(slow);
    };
  }, [needle]);

  const places = useMemo(() => {
    const names = new Set(online.map((place) => place.name.toLowerCase()));
    const towns = local
      .filter((place) => !names.has(place.name.toLowerCase()))
      .map((place) => ({ name: place.name, detail: place.state, kind: "Town", lat: place.lat, lon: place.lon, osm: null }));
    return [...online, ...towns].slice(0, 7);
  }, [online, local]);

  const radioMatches = needle
    ? radios.filter((radio) => radio.name.toLowerCase().includes(needle.toLowerCase())).slice(0, 5)
    : [];

  async function pickPlace(place) {
    setProblem(null);
    const label = place.name;
    if (place.osm) {
      setBusy(place.osm);
      try {
        const data = await queryClient.fetchQuery(borderQuery(place.osm));
        if (data?.points?.length >= 3) {
          onPlace({ kind: "border", label, points: data.points });
          return;
        }
      } catch {
        // No border to be had: the circle below still puts the zone in the right place.
      } finally {
        setBusy(null);
      }
    }
    onPlace({ kind: "point", label, lat: place.lat, lon: place.lon, radius: radiusForKind(place.kind) });
  }

  function pickMyLocation() {
    setProblem(null);
    if (!window.navigator.geolocation) return setProblem("This device can't share its location.");
    setBusy("me");
    window.navigator.geolocation.getCurrentPosition(
      (position) => {
        setBusy(null);
        onPlace({ kind: "point", label: "", lat: position.coords.latitude, lon: position.coords.longitude, radius: DEFAULT_RADIUS });
      },
      () => {
        setBusy(null);
        setProblem("Couldn't get your location. Allow location access, or type the place instead.");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  }

  const row = "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-white/[0.06] active:bg-white/[0.1]";
  return (
    <div>
      <h2 className="mb-2 text-[13px] font-bold text-neutral-100">Where is the place?</h2>
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
        <input
          aria-label="Place, area or radio"
          autoFocus
          className="field-input py-2.5 pl-9 text-[12px]"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A town, area, building or radio"
          value={query}
        />
      </div>

      <div className="mt-1.5 rounded-lg border border-white/10 bg-white/[0.02] p-1">
        <button className={row} disabled={Boolean(busy)} onClick={pickMyLocation} type="button">
          {busy === "me" ? <LoaderCircle className="animate-spin text-sky-300" size={14} /> : <LocateFixed className="text-sky-300" size={14} />}
          <span className="text-[11px] font-bold text-neutral-200">My location</span>
          <span className="ml-auto text-[9px] text-neutral-500">Where this device is</span>
        </button>

        {places.length ? <p className="px-2.5 pb-0.5 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Places</p> : null}
        {places.map((place) => (
          <button
            className={row}
            disabled={Boolean(busy)}
            key={`${place.osm || place.name}-${place.detail}`}
            onClick={() => pickPlace(place)}
            // The border is usually loaded before the click lands.
            onMouseEnter={() => place.osm && queryClient.prefetchQuery(borderQuery(place.osm))}
            type="button"
          >
            {busy === place.osm ? <LoaderCircle className="animate-spin text-neutral-400" size={14} /> : <MapPin className="text-neutral-500" size={14} />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] font-bold text-neutral-200">{place.name}</span>
              <span className="block truncate text-[9px] text-neutral-500">{[place.kind, place.detail].filter(Boolean).join(" · ")}</span>
            </span>
            {place.osm ? <span className="shrink-0 rounded bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-bold text-emerald-300">Has border</span> : null}
          </button>
        ))}

        {radioMatches.length ? <p className="px-2.5 pb-0.5 pt-2 text-[9px] font-bold uppercase tracking-wide text-neutral-600">Radios</p> : null}
        {radioMatches.map((radio) => (
          <button
            className={row}
            disabled={Boolean(busy)}
            key={radio.key}
            onClick={() => onPlace({ kind: "point", label: `${radio.name} area`, lat: radio.lat, lon: radio.lon, radius: DEFAULT_RADIUS })}
            type="button"
          >
            <Radio className="text-neutral-500" size={14} />
            <span className="truncate text-[11px] font-bold text-neutral-200">{radio.name}</span>
            <span className="ml-auto shrink-0 text-[9px] text-neutral-500">Where it is now</span>
          </button>
        ))}

        {needle.length >= 3 && !places.length && !radioMatches.length ? (
          <p className="px-2.5 py-2 text-[10px] text-neutral-500">Nothing found by that name. Try a nearby town, or draw it yourself.</p>
        ) : null}
      </div>

      {problem ? <p className="mt-1.5 text-[10px] text-amber-300">{problem}</p> : null}

      <div className="mt-3 flex items-center gap-2 text-[10px] text-neutral-600">
        <span className="h-px flex-1 bg-white/10" /> or <span className="h-px flex-1 bg-white/10" />
      </div>
      <div className="mt-2 grid gap-1.5">
        <button
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-white/[0.08] px-3 py-2.5 text-[11px] font-bold text-neutral-100 hover:bg-white/[0.12] active:bg-white/[0.16]"
          onClick={onDraw}
          type="button"
        >
          <PenLine size={13} /> Draw it myself
        </button>
        {aroundCount ? (
          <button
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[10px] font-bold text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100"
            onClick={onAround}
            type="button"
          >
            <Users size={12} /> Around the {aroundCount} radio{aroundCount === 1 ? "" : "s"} you chose
          </button>
        ) : null}
      </div>
    </div>
  );
}
