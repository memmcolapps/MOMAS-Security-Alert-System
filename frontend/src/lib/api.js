import { config } from "./app-config";

const TOKEN_KEY = "momas_auth_token";

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      ...options.headers,
    },
    ...options,
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    if (response.status === 401) setAuthToken(null);
    throw new Error(body?.error || body?.message || response.statusText);
  }
  return body;
}

export function login(payload) {
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getMe() {
  return request("/api/auth/me");
}

export function listOrganizations() {
  return request("/api/organizations");
}

export function createOrganization(payload) {
  return request("/api/organizations", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateOrganizationAccess(id, payload) {
  return request(`/api/organizations/${id}/access`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getOrganization(id) {
  return request(`/api/organizations/${id}`);
}

export function addOrganizationUser(id, payload) {
  return request(`/api/organizations/${id}/users`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeOrganizationUser(orgId, userId) {
  return request(`/api/organizations/${orgId}/users/${userId}`, {
    method: "DELETE",
  });
}

export function attachDeviceToOrganization(orgId, deviceId) {
  return request(`/api/organizations/${orgId}/devices/${encodeURIComponent(deviceId)}`, {
    method: "POST",
    body: "{}",
  });
}

export function detachDeviceFromOrganization(orgId, deviceId) {
  return request(`/api/organizations/${orgId}/devices/${encodeURIComponent(deviceId)}`, {
    method: "DELETE",
  });
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
