import { useEffect, useState } from "react";

// One animation frame loop and one one-second clock for the whole page. A wall
// of tracked-radio tiles would otherwise run a loop and a timer per tile.

const frameListeners = new Set();
let frameId = null;

function runFrame() {
  frameId = window.requestAnimationFrame(runFrame);
  const now = Date.now();
  for (const listener of frameListeners) listener(now);
}

/** Calls `listener(now)` on every frame until the returned function is called. */
export function onFrame(listener) {
  frameListeners.add(listener);
  if (frameId == null) frameId = window.requestAnimationFrame(runFrame);
  return () => {
    frameListeners.delete(listener);
    if (!frameListeners.size && frameId != null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
  };
}

const secondListeners = new Set();
let secondTimer = null;

/** The current time, updated once a second, shared by every caller. */
export function useSecondClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    secondListeners.add(setNow);
    if (!secondTimer) {
      secondTimer = window.setInterval(() => {
        const at = Date.now();
        for (const listener of secondListeners) listener(at);
      }, 1000);
    }
    return () => {
      secondListeners.delete(setNow);
      if (!secondListeners.size) {
        window.clearInterval(secondTimer);
        secondTimer = null;
      }
    };
  }, []);
  return now;
}
