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

export function getSystemHealth() {
  return request("/api/health");
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

// Take on a company the radio-network sync discovered. The seat counts are sent
// with it because promotion is where they stop describing what the vendor gave
// the company and start being an allocation MOMAS owns.
export function promoteOrganization(id, payload) {
  return request(`/api/organizations/${id}/promote`, {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

// Bring the radio network's dispatcher seats up to the allowance. Idempotent,
// so it is both the retry when promotion's own attempt failed and the way to
// apply a raised allowance.
export function topUpOrganizationSeats(id) {
  return request(`/api/organizations/${id}/radio/seats`, { method: "POST" });
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

export function allocateRadioToOrganization(deviceId, organizationId, channelIds) {
  return request(`/api/pocstars/admin/devices/${encodeURIComponent(deviceId)}/allocate`, {
    method: "POST",
    body: JSON.stringify({
      organization_id: organizationId,
      ...(channelIds === undefined ? {} : { channel_ids: channelIds }),
    }),
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

export function createPlatformChannel(payload) {
  return request("/api/pocstars/admin/channels", {
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

// The review queue grouped into events: one card per event, every outlet's
// report of it underneath.
export function getReviewQueue() {
  return request("/api/osint/review-queue");
}

// Publish an event's lead report and attach the rest as supporting evidence.
export function approveReviewEvent({ lead_id, ids, analyst_note }) {
  return request("/api/osint/review-queue/approve", {
    method: "POST",
    body: JSON.stringify({ lead_id, ids, analyst_note }),
  });
}

export function dismissReviewEvent({ lead_id, ids, analyst_note }) {
  return request("/api/osint/review-queue/dismiss", {
    method: "POST",
    body: JSON.stringify({ lead_id, ids, analyst_note }),
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

export function getOsintSourceAnalytics() {
  return request("/api/osint/analytics/sources");
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

// The trail behind a tracked radio: the fixes the server recorded in the last
// `minutes`, oldest first.
export function getRadioTrack(uid, minutes = 30) {
  return request(`/api/pocstars/locations/${encodeURIComponent(uid)}/track?minutes=${minutes}`);
}

// One radio's points between two moments (epoch ms), for replaying its shift.
export function getRadioReplay(uid, from, to) {
  const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  return request(`/api/pocstars/locations/${encodeURIComponent(uid)}/replay?${query}`);
}

// Where radios have been in the last `hours`, as grid squares.
export function getRadioCoverage(hours = 4) {
  return request(`/api/pocstars/positions/coverage?hours=${hours}`);
}

// Every GPS point radios sent in the last `seconds`, for a map that has just
// opened (or reconnected) to start playing from.
export function getRecentRadioPoints(seconds = 120) {
  return request(`/api/pocstars/positions/recent?seconds=${seconds}`);
}

// The live stream of radio points. EventSource cannot set headers, so the token
// and active org ride along as query params, as for the alerts stream.
export function radioPointsStreamUrl() {
  const query = new URLSearchParams();
  const token = getAuthToken();
  const org = getActiveOrganizationId();
  if (token) query.set("access_token", token);
  if (org) query.set("organization_id", org);
  return `${config.apiBase}/api/pocstars/positions/stream?${query}`;
}

// Radio positions are shared by one server-side poll, so asking often is cheap.
// 5s keeps a moving radio's glide close to where it really is.
export const RADIO_POLL_MS = 5_000;

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

// React Query refetchInterval for drone positions: a flying drone is tracked at
// 3s, but with none online the map was still asking every 3s all shift.
export function dronePollInterval(query) {
  const drones = query.state.data?.drones || [];
  return drones.some((drone) => drone.online) ? 3_000 : 15_000;
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
