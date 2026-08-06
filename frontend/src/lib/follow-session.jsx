import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

const FollowContext = createContext(null);

const EARTH_RADIUS_M = 6371000;
const toRad = (value) => (value * Math.PI) / 180;
const toDeg = (value) => (value * 180) / Math.PI;

export function haversineMetres(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

// Initial great-circle bearing. Over the distances involved here the difference
// from the final bearing is immaterial, and this is the number you steer by.
export function bearingDegrees(lat1, lon1, lat2, lon2) {
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compassPoint(bearing) {
  return COMPASS[Math.round(bearing / 22.5) % 16];
}

export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return "—";
  if (metres < 1000) return `${Math.round(metres)} m`;
  if (metres < 10000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.round(metres / 1000)} km`;
}

/**
 * Hands the destination to whatever navigation app the device has. Origin is
 * deliberately omitted: Google routes from the device's own location, which
 * means the responder's position is never sent anywhere, and the URL can be
 * built synchronously inside the click handler - an async build would be
 * popup-blocked, because by the time a geolocation callback fires the browser
 * no longer considers it a user gesture.
 */
export function navigationUrl(target) {
  const destination = `${target.lat.toFixed(6)},${target.lon.toFixed(6)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=driving&dir_action=navigate`;
}

// Whether this browser is installed in a vehicle rather than sitting on a desk.
// Nothing on the server can tell us - the same account signs in from both - so
// the crew marks the device once, and that is what decides whether we ask for
// location up front.
const MOBILE_STATION_KEY = "momas_mobile_station";

export function isMobileStation() {
  try {
    return window.localStorage.getItem(MOBILE_STATION_KEY) === "true";
  } catch {
    return false;
  }
}

export function FollowProvider({ children }) {
  const [target, setTarget] = useState(null);
  const [position, setPosition] = useState(null);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState("unknown");
  const [mobileStation, setMobileStationState] = useState(isMobileStation);
  const watchRef = useRef(null);

  const setMobileStation = useCallback((value) => {
    try {
      window.localStorage.setItem(MOBILE_STATION_KEY, value ? "true" : "false");
    } catch {
      // A browser refusing storage still gets the setting for this session.
    }
    setMobileStationState(Boolean(value));
  }, []);

  // Asking forces the browser's prompt, which only the person holding the
  // device can answer - no server or admin console can grant this for them.
  const requestLocationAccess = useCallback(
    () =>
      new Promise((resolve) => {
        if (!window.navigator.geolocation) {
          setPermission("unsupported");
          resolve("unsupported");
          return;
        }
        window.navigator.geolocation.getCurrentPosition(
          () => {
            setPermission("granted");
            resolve("granted");
          },
          (failure) => {
            const next = failure.code === failure.PERMISSION_DENIED ? "denied" : "prompt";
            setPermission(next);
            resolve(next);
          },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
        );
      }),
    [],
  );

  // Read the current state without prompting, and keep it live - a crew that
  // fixes the setting in browser preferences should see the indicator go green
  // without signing in again.
  useEffect(() => {
    if (!window.navigator.geolocation) {
      setPermission("unsupported");
      return undefined;
    }
    if (!window.navigator.permissions?.query) {
      setPermission("unknown");
      return undefined;
    }
    let status = null;
    const onChange = () => setPermission(status.state);
    window.navigator.permissions
      .query({ name: "geolocation" })
      .then((result) => {
        status = result;
        setPermission(result.state);
        result.addEventListener("change", onChange);
      })
      .catch(() => setPermission("unknown"));
    return () => status?.removeEventListener("change", onChange);
  }, []);

  // The whole point of the pre-flight: a vehicle sorts its location out while
  // parked, not through a dialog that appears over a live alarm.
  const askedRef = useRef(false);
  useEffect(() => {
    if (askedRef.current || !mobileStation || permission !== "prompt") return;
    askedRef.current = true;
    void requestLocationAccess();
  }, [mobileStation, permission, requestLocationAccess]);

  const stopFollowing = useCallback(() => {
    setTarget(null);
    setPosition(null);
    setError("");
  }, []);

  const follow = useCallback((next) => {
    if (!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return;
    setError("");
    setPosition(null);
    setTarget(next);
  }, []);

  useEffect(() => {
    if (!target) {
      if (watchRef.current != null) {
        window.navigator.geolocation?.clearWatch(watchRef.current);
        watchRef.current = null;
      }
      return undefined;
    }
    if (!window.navigator.geolocation) {
      setError("This device cannot report its location.");
      return undefined;
    }
    watchRef.current = window.navigator.geolocation.watchPosition(
      (fix) => {
        setError("");
        setPosition({
          lat: fix.coords.latitude,
          lon: fix.coords.longitude,
          accuracy_m: fix.coords.accuracy,
          heading: Number.isFinite(fix.coords.heading) ? fix.coords.heading : null,
          at: fix.timestamp,
        });
      },
      (failure) => {
        // The last known fix is kept on purpose. A vehicle driving through a
        // gap in coverage should keep its bearing and distance rather than
        // blank out at the moment they matter most.
        setError(
          failure.code === failure.PERMISSION_DENIED
            ? "Location permission is blocked, so the distance cannot be worked out."
            : "Waiting for a GPS fix…",
        );
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
    );
    return () => {
      if (watchRef.current != null) {
        window.navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
      }
    };
  }, [target]);

  // Screens sleep. A response that takes twenty minutes should not need
  // somebody to keep tapping the glass.
  useEffect(() => {
    if (!target || !window.navigator.wakeLock) return undefined;
    let sentinel = null;
    let released = false;
    const request = () =>
      window.navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (released) lock.release().catch(() => {});
          else sentinel = lock;
        })
        .catch(() => {});
    request();
    const onVisible = () => {
      if (window.document.visibilityState === "visible" && !sentinel) request();
    };
    window.document.addEventListener("visibilitychange", onVisible);
    return () => {
      released = true;
      window.document.removeEventListener("visibilitychange", onVisible);
      sentinel?.release().catch(() => {});
    };
  }, [target]);

  const value = useMemo(() => {
    const distance_m =
      target && position ? haversineMetres(position.lat, position.lon, target.lat, target.lon) : null;
    const bearing =
      target && position ? bearingDegrees(position.lat, position.lon, target.lat, target.lon) : null;
    return {
      target,
      position,
      error,
      distance_m,
      bearing,
      following: Boolean(target),
      follow,
      stopFollowing,
      permission,
      requestLocationAccess,
      mobileStation,
      setMobileStation,
    };
  }, [
    target,
    position,
    error,
    follow,
    stopFollowing,
    permission,
    requestLocationAccess,
    mobileStation,
    setMobileStation,
  ]);

  return <FollowContext.Provider value={value}>{children}</FollowContext.Provider>;
}

export function useFollow() {
  const context = useContext(FollowContext);
  if (!context) throw new Error("useFollow requires a FollowProvider.");
  return context;
}
