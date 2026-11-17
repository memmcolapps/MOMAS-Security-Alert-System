// What this browser tells the server about itself at sign-in, and how long
// ago someone last touched it.

const DEVICE_KEY = "momas_device_id";

/**
 * A random id this browser keeps, so the server recognises it next time and
 * an admin can approve or block it. It is not secret from the person holding
 * the phone; it only has to be unguessable by anyone else.
 */
export function deviceId() {
  try {
    let id = window.localStorage.getItem(DEVICE_KEY);
    if (!id || !/^[A-Za-z0-9_-]{16,128}$/.test(id)) {
      const bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      id = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
      window.localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/**
 * A phone or tablet. "Request desktop site" changes what the browser calls
 * itself but not the touch screen, so both are asked.
 */
export function isPhone() {
  const nav = window.navigator;
  if (nav.userAgentData?.mobile) return true;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return true;
  // iPadOS and desktop-mode phones report a desktop browser but have touch only.
  const touchOnly = nav.maxTouchPoints > 1 && window.matchMedia?.("(hover: none) and (pointer: coarse)").matches;
  return Boolean(touchOnly);
}

export function deviceInfo() {
  return { id: deviceId(), phone: isPhone() };
}

// ── Last use ────────────────────────────────────────────────────────────────

let lastInputAt = Date.now();
let tracking = false;

/** Starts noting touches and keys, once. Automatic refreshes are not use. */
export function trackInput() {
  if (tracking) return;
  tracking = true;
  const note = () => {
    lastInputAt = Date.now();
  };
  for (const name of ["pointerdown", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(name, note, { passive: true, capture: true });
  }
}

/** Whole seconds since someone last touched the screen or a key. */
export function secondsSinceInput() {
  return Math.max(0, Math.floor((Date.now() - lastInputAt) / 1000));
}

export function noteInputNow() {
  lastInputAt = Date.now();
}

// ── Location at sign-in ─────────────────────────────────────────────────────

/**
 * Where the device is, if it will say within a few seconds. A computer that
 * has not been allowed location is not asked: a prompt on the sign-in page
 * would only get in the way. A phone is asked, since it is the device most
 * likely to be lost or taken.
 */
export async function signInLocation() {
  const geo = window.navigator.geolocation;
  if (!geo) return null;
  let state = "prompt";
  try {
    state = (await window.navigator.permissions?.query({ name: "geolocation" }))?.state || "prompt";
  } catch {
    // Safari before 16 has no permissions API; treat as not yet asked.
  }
  if (state === "denied" || (state === "prompt" && !isPhone())) return null;
  return new Promise((resolve) => {
    const timer = window.setTimeout(() => resolve(null), 4000);
    geo.getCurrentPosition(
      (position) => {
        window.clearTimeout(timer);
        resolve({ lat: position.coords.latitude, lon: position.coords.longitude });
      },
      () => {
        window.clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 4000 },
    );
  });
}
