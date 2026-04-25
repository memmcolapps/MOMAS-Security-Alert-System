import { config } from "./app-config";

async function request(path, options = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(body?.error || body?.message || response.statusText);
  }
  return body;
}

export function getIncidents(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, value);
    }
  });
  return request(`/api/incidents?${query}`);
}

export function triggerScrape() {
  return request("/api/incidents/scrape", { method: "POST", body: "{}" });
}

export function reverseGeocode(lat, lon) {
  const query = new URLSearchParams({ lat, lon });
  return request(`/api/incidents/reverse-geocode?${query}`);
}

export function listDevices() {
  return request("/api/pocstars/devices");
}

export function saveDevice(payload) {
  return request("/api/pocstars/devices", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteDevice(deviceId) {
  return request(`/api/pocstars/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
}

export function getLocations(uids = []) {
  const query = uids.length
    ? `?${new URLSearchParams({ uids: uids.join(",") })}`
    : "";
  return request(`/api/pocstars/locations${query}`);
}

export function getSosLog() {
  return request("/api/pocstars/sos/log");
}

export function acknowledgeSos(sosMsgId) {
  return request(`/api/pocstars/sos/${sosMsgId}/acknowledge`, {
    method: "POST",
    body: "{}",
  });
}

export function resolveSos(sosMsgId) {
  return request(`/api/pocstars/sos/${sosMsgId}/resolve`, {
    method: "POST",
    body: "{}",
  });
}
