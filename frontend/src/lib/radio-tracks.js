import { useEffect, useRef } from "react";
import { getRecentRadioPoints, radioPointsStreamUrl } from "./api";
import { addPoints, createTrack } from "./radio-playback";

// A track with nothing new for this long is dropped, and the radio falls back
// to its last polled position.
const FORGET_MS = 20 * 60_000;

/**
 * Every radio's recent GPS points, kept in a ref the map reads on each frame.
 * Nothing here causes a re-render: the points arrive several times a second
 * across the fleet, and only the map's animation loop needs them.
 */
export function useRadioTracks() {
  const tracksRef = useRef(new Map());

  useEffect(() => {
    let cancelled = false;
    const tracks = tracksRef.current;
    const ingest = (points, live) => {
      const now = Date.now();
      const byRadio = new Map();
      for (const point of points || []) {
        const uid = String(point.uid);
        if (!byRadio.has(uid)) byRadio.set(uid, []);
        byRadio.get(uid).push(point);
      }
      for (const [uid, radioPoints] of byRadio) {
        if (!tracks.has(uid)) tracks.set(uid, createTrack());
        addPoints(tracks.get(uid), radioPoints, now, { live });
      }
    };
    // Run on every (re)connect: it fills whatever the stream missed while it
    // was down, and duplicates are ignored.
    const backfill = () =>
      getRecentRadioPoints(120)
        .then((result) => !cancelled && ingest(result.points, false))
        .catch(() => {});

    const source = new window.EventSource(radioPointsStreamUrl());
    source.onopen = backfill;
    source.addEventListener("points", (event) => {
      try {
        ingest(JSON.parse(event.data), true);
      } catch {
        // A malformed batch is skipped; the next one carries on.
      }
    });
    const sweep = window.setInterval(() => {
      const cutoff = Date.now() - FORGET_MS;
      for (const [uid, track] of tracks) {
        const newest = track.raw[track.raw.length - 1];
        if (!newest || newest.t < cutoff) tracks.delete(uid);
      }
    }, 60_000);

    return () => {
      cancelled = true;
      source.close();
      window.clearInterval(sweep);
      tracks.clear();
    };
  }, []);

  return tracksRef;
}
