import { config } from "./app-config";

const TOKEN_KEY = "momas_auth_token";
const ORG_KEY = "momas_active_organization_id";

export function getAuthToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setAuthToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ORG_KEY);
  }
}

export function getActiveOrganizationId() {
  return localStorage.getItem(ORG_KEY);
}

export function setActiveOrganizationId(organizationId) {
  if (organizationId) localStorage.setItem(ORG_KEY, String(organizationId));
  else localStorage.removeItem(ORG_KEY);
}

async function request(path, options = {}) {
  const response = await fetch(`${config.apiBase}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}` } : {}),
      ...(getActiveOrganizationId() ? { "X-Organization-Id": getActiveOrganizationId() } : {}),
      ...options.headers,
    },
    ...options,
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text };
    }
  }
  if (!response.ok) {
    if (response.status === 401) setAuthToken(null);
    // `message` is the operator-facing sentence; `error` is the machine code.
    // Prefer the sentence so raw codes never reach the screen.
    const error = new Error(body?.message || body?.error || response.statusText);
    error.status = response.status;
    error.code = body?.error || null;
    error.body = body;
    throw error;
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

export function changePassword(payload) {
  return request("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify(payload),
  });
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

export function provisionOrganizationRadio(id) {
  return request(`/api/organizations/${id}/radio/provision`, { method: "POST" });
}

export function getOrganizationDeletionImpact(id) {
  return request(`/api/organizations/${id}/deletion-impact`);
}

export function deleteOrganization(id, confirmName) {
  return request(`/api/organizations/${id}?confirm=${encodeURIComponent(confirmName)}`, {
    method: "DELETE",
  });
}

export function getRadioChannels() {
  return request("/api/pocstars/radio/channels");
}

export function listOrgChannels() {
  return request("/api/org/channels");
}

export function createOrgChannel(payload) {
  return request("/api/org/channels", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateOrgChannel(channelId, payload) {
  return request(`/api/org/channels/${channelId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteOrgChannel(channelId) {
  return request(`/api/org/channels/${channelId}`, { method: "DELETE" });
}

export function listOrgChannelDevices(channelId) {
  return request(`/api/org/channels/${channelId}/devices`);
}

export function setOrgChannelDevice(channelId, deviceId, member) {
  return request(`/api/org/channels/${channelId}/devices/${deviceId}`, {
    method: member ? "POST" : "DELETE",
  });
}

export function allocateRadioToOrganization(deviceId, organizationId) {
  return request(`/api/pocstars/admin/devices/${deviceId}/allocate`, {
    method: "POST",
    body: JSON.stringify({ organization_id: organizationId }),
  });
}

// Onboarding a handset is not the same call as editing one. The radio network
// assigns the id, so this creates the radio there first and returns the device
// it created here - which is why there is no device_id to send.
export function onboardRadio(payload) {
  return request("/api/pocstars/admin/radios", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getPocstarsRegistry() {
  return request("/api/pocstars/admin/registry");
}

export function runPocstarsPlatformSync() {
  return request("/api/pocstars/admin/sync", {
    method: "POST",
    body: "{}",
  });
}

export function assignPocstarsGroup(groupId, payload) {
  return request(`/api/pocstars/admin/groups/${groupId}/assign`, {
    method: "POST",
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

export function getPlatformStaff() {
  return request("/api/platform/staff");
}

export function createPlatformStaff(payload) {
  return request("/api/platform/staff", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updatePlatformStaffRole(userId, platform_role) {
  return request(`/api/platform/staff/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ platform_role }),
  });
}

export function removePlatformStaff(userId) {
  return request(`/api/platform/staff/${userId}`, {
    method: "DELETE",
  });
}

export function getOrgAdmin() {
  return request("/api/org");
}

export function addOrgAdminUser(payload) {
  return request("/api/org/users", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeOrgAdminUser(userId) {
  return request(`/api/org/users/${userId}`, {
    method: "DELETE",
  });
}

export function createOrgUnit(payload) {
  return request("/api/org/units", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateOrgUnit(unitId, payload) {
  return request(`/api/org/units/${unitId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteOrgUnit(unitId) {
  return request(`/api/org/units/${unitId}`, {
    method: "DELETE",
  });
}

export function assignDeviceUnit(deviceId, unitId) {
  return request(`/api/org/devices/${encodeURIComponent(deviceId)}/unit`, {
    method: "POST",
    body: JSON.stringify({ unit_id: unitId || null }),
  });
}

export function getOrgAudit() {
  return request("/api/org/audit");
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

export function getIncidentEvidence(id) {
  return request(`/api/incidents/${encodeURIComponent(id)}/evidence`);
}

export function getIncidentReport(id) {
  return request(`/api/incidents/${encodeURIComponent(id)}/report`);
}

export function listOsintItems(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/osint/items?${query}`);
}

export function getOsintItem(id) {
  return request(`/api/osint/items/${encodeURIComponent(id)}`);
}

export function extractOsintItem(id) {
  return request(`/api/osint/items/${encodeURIComponent(id)}/extract`, {
    method: "POST",
    body: "{}",
  });
}

export function reviewOsintItem(id, payload) {
  return request(`/api/osint/items/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function linkOsintItem(id, payload) {
  return request(`/api/osint/items/${encodeURIComponent(id)}/link`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function promoteOsintItem(id, payload = {}) {
  return request(`/api/osint/items/${encodeURIComponent(id)}/promote`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listOsintSources() {
  return request("/api/osint/sources");
}

export function saveOsintSource(payload) {
  return request("/api/osint/sources", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteOsintSource(id) {
  return request(`/api/osint/sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listOsintWatchlists() {
  return request("/api/osint/watchlists");
}

export function saveOsintWatchlist(payload) {
  return request("/api/osint/watchlists", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteOsintWatchlist(id) {
  return request(`/api/osint/watchlists/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listOsintEntities(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/osint/entities?${query}`);
}

export function listOsintAlerts(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/osint/alerts?${query}`);
}

export function updateOsintAlertStatus(id, status) {
  return request(`/api/osint/alerts/${encodeURIComponent(id)}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });
}

export function evaluateOsintAlerts(payload = {}) {
  return request("/api/osint/alerts/evaluate", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getOsintSourceAnalytics() {
  return request("/api/osint/analytics/sources");
}

// Builds the authenticated URL for the OSINT live alert SSE stream. EventSource
// cannot set headers, so the token and active org ride along as query params.
export function osintEventsUrl() {
  const query = new URLSearchParams();
  const token = getAuthToken();
  const org = getActiveOrganizationId();
  if (token) query.set("access_token", token);
  if (org) query.set("organization_id", org);
  return `${config.apiBase}/api/osint/events?${query}`;
}

export function getOsintGraph(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/osint/graph?${query}`);
}

export function getOsintBrief(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/osint/reports/brief?${query}`);
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

export function listRadioRecordings(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/pocstars/radio/recordings?${query}`);
}

export function radioRecordingAudioUrl(playbackToken) {
  const query = new URLSearchParams();
  const token = getAuthToken();
  const org = getActiveOrganizationId();
  if (token) query.set("access_token", token);
  if (org) query.set("organization_id", org);
  return `${config.apiBase}/api/pocstars/radio/recordings/${encodeURIComponent(playbackToken)}/audio?${query}`;
}

export function sendRadioMessage(payload) {
  return request("/api/pocstars/radio/messages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function listAlarms(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return request(`/api/alerts?${query}`);
}

function alertParts(alertKey) {
  const value = String(alertKey || "");
  const separator = value.indexOf(":");
  if (separator < 0) return { source: "pocstars", id: value };
  return { source: value.slice(0, separator), id: value.slice(separator + 1) };
}

export function getAlarm(alertKey) {
  const { source, id } = alertParts(alertKey);
  return request(`/api/alerts/${encodeURIComponent(source)}/${encodeURIComponent(id)}`);
}

function alarmAction(alertKey, action, note) {
  const { source, id } = alertParts(alertKey);
  const path =
    source === "geofence"
      ? `/api/alerts/geofence/${encodeURIComponent(id)}/${action}`
      : `/api/pocstars/alarms/${encodeURIComponent(id)}/${action}`;
  return request(path, {
    method: "POST",
    body: JSON.stringify({ note: note || "" }),
  });
}

export function startAlarmResponse({ alertKey, note } = {}) {
  return alarmAction(alertKey, "start-response", note);
}

export function resolveAlarm({ alertKey, sosMsgId, note, resolution_note }) {
  return alarmAction(alertKey || sosMsgId, "resolve", note ?? resolution_note);
}

export function reopenAlarm({ alertKey, note }) {
  return alarmAction(alertKey, "reopen", note);
}

export function alertsEventsUrl() {
  const query = new URLSearchParams();
  const token = getAuthToken();
  const org = getActiveOrganizationId();
  if (token) query.set("access_token", token);
  if (org) query.set("organization_id", org);
  return `${config.apiBase}/api/alerts/events?${query}`;
}

export function listGeofences() {
  return request("/api/geofences");
}

export function saveGeofence(payload) {
  const id = payload.id;
  return request(id ? `/api/geofences/${encodeURIComponent(id)}` : "/api/geofences", {
    method: id ? "PUT" : "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteGeofence(id) {
  return request(`/api/geofences/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function searchPlaces(query) {
  return request(`/api/geofences/places?${new URLSearchParams({ q: query })}`);
}

/** Dry run: what this shape covers, how big it is, and where it is. */
export function previewGeofence(payload) {
  return request("/api/geofences/preview", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getDronePositions() {
  return request("/api/drones/positions");
}

export function getDroneRegistry() {
  return request("/api/drones/registry");
}

export function saveDrone(payload) {
  return request("/api/drones/registry", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteDrone(sysid) {
  return request(`/api/drones/registry/${encodeURIComponent(sysid)}`, {
    method: "DELETE",
  });
}

export function acknowledgeSos(sosMsgId) {
  return startAlarmResponse({ alertKey: sosMsgId });
}

export function resolveSos(sosMsgId, note = "") {
  return resolveAlarm({ sosMsgId, note });
}
