import { config } from "./app-config";
import { noteServerReached, noteServerUnreachable } from "./connection";
import { clearOfflineCache } from "./offline-cache";
import { deviceInfo, secondsSinceInput, signInLocation } from "./device";
import { createSharedEventSource } from "./shared-event-source";

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

function userOfToken(token) {
  try {
    return token ? JSON.parse(window.atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).sub ?? null : null;
  } catch {
    return null;
  }
}

// Another tab signed out, or signed in as someone else: this tab must not keep
// showing (or saving) the previous person's data. A renewed token for the same
// person changes nothing.
window.addEventListener("storage", (event) => {
  if (event.key !== TOKEN_KEY) return;
  const before = userOfToken(event.oldValue);
  const after = userOfToken(event.newValue);
  if (before === after) return;
  window.location.assign(after ? "/" : "/login");
});

export function getActiveOrganizationId() {
  return localStorage.getItem(ORG_KEY);
}

export function setActiveOrganizationId(organizationId) {
  if (organizationId) localStorage.setItem(ORG_KEY, String(organizationId));
  else localStorage.removeItem(ORG_KEY);
}

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(`${config.apiBase}${path}`, {
      headers: {
        "Content-Type": "application/json",
        ...(getAuthToken() ? { Authorization: `Bearer ${getAuthToken()}`, "X-Last-Input": String(secondsSinceInput()) } : {}),
        ...(getActiveOrganizationId() ? { "X-Organization-Id": getActiveOrganizationId() } : {}),
        ...options.headers,
      },
      ...options,
    });
  } catch (cause) {
    if (cause?.name === "AbortError") throw cause;
    // The browser's own "Failed to fetch" tells the operator nothing. Say
    // what happened, and for a change, that it did not go through.
    noteServerUnreachable();
    const offline = !window.navigator.onLine;
    const write = options.method && options.method !== "GET";
    const error = new Error(
      `${offline ? "You're offline." : "Can't reach the EPAIL server."}${write ? " Nothing was saved." : ""}`,
    );
    error.status = 0;
    error.code = offline ? "offline" : "server_unreachable";
    throw error;
  }
  noteServerReached();
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
    if (response.status === 401) {
      const wasSignedIn = Boolean(getAuthToken());
      setAuthToken(null);
      clearOfflineCache();
      // Signed out from elsewhere (a lost phone, an admin, a time limit):
      // reload onto the sign-in page so nothing already on screen stays there.
      if (wasSignedIn && window.location.pathname !== "/login") window.location.assign("/login");
    }
    if (response.status === 423) emitSessionEvent("locked");
    if (response.status === 403 && body?.error === "pin_required") emitSessionEvent("pin_required");
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

// A sign-in lasts 12 hours. While the console is open it swaps its session for
// a fresh one every half hour, so nobody is signed out mid-shift; a copied
// token dies within 12 hours of the console that held it closing.
const SESSION_RENEW_MS = 30 * 60 * 1000;
let lastRenewAt = Date.now();

async function renewSession() {
  if (!getAuthToken()) return;
  lastRenewAt = Date.now();
  try {
    const result = await request("/api/auth/refresh", { method: "POST", body: JSON.stringify({ device: deviceInfo() }) });
    // Only if nobody signed out or in while the request was out.
    if (result?.token && getAuthToken()) setAuthToken(result.token);
  } catch {
    // Offline: try again on the next tick. A 401 has already signed us out.
  }
}

export function keepSessionFresh() {
  const timer = window.setInterval(renewSession, SESSION_RENEW_MS);
  // A laptop waking from sleep renews at once rather than waiting for the timer.
  const onVisible = () => {
    if (window.document.visibilityState === "visible" && Date.now() - lastRenewAt > SESSION_RENEW_MS) renewSession();
  };
  window.document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    window.document.removeEventListener("visibilitychange", onVisible);
  };
}

export function getSystemHealth() {
  return request("/api/health");
}

// The lock screen and PIN setup listen here for the server saying this
// session is locked or needs a PIN.
const sessionListeners = new Set();

function emitSessionEvent(type) {
  for (const listener of sessionListeners) listener(type);
}

export function onSessionEvent(listener) {
  sessionListeners.add(listener);
  return () => sessionListeners.delete(listener);
}

export async function login({ email, password }) {
  // The device and where it is go with the password: the server checks the
  // device is allowed and notes the place, to spot an unusual one.
  const location = await signInLocation().catch(() => null);
  return request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ email, password, device: deviceInfo(), location }),
  });
}

/** Ends this sign-in on the server too, so it leaves the device list at once. */
export async function signOut() {
  const token = getAuthToken();
  if (token) {
    await fetch(`${config.apiBase}/api/auth/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: window.AbortSignal.timeout(3000),
    }).catch(() => {});
  }
  setAuthToken(null);
  clearOfflineCache();
}

// ── My devices, PIN and panic secrets ──────────────────────────────────────

export function getMySessions() {
  return request("/api/auth/sessions");
}

export function endMySession(sessionId) {
  return request(`/api/auth/sessions/${encodeURIComponent(sessionId)}/end`, { method: "POST" });
}

export function reportDeviceLost(deviceId) {
  return request(`/api/auth/devices/${encodeURIComponent(deviceId)}/lost`, { method: "POST" });
}

export function setAppPin({ password, pin }) {
  return request("/api/auth/pin", { method: "POST", body: JSON.stringify({ password, pin }) });
}

export function setPanicSecrets(payload) {
  return request("/api/auth/panic", { method: "POST", body: JSON.stringify(payload) });
}

export function unlockApp(pin) {
  return request("/api/auth/unlock", { method: "POST", body: JSON.stringify({ pin }) });
}

// ── Sign-in rules and people's devices, for admins ─────────────────────────

export function getOrgSecurity(orgId) {
  return request(orgPath("/api/org/security", orgId));
}

export function saveOrgSecurity(policy, orgId) {
  return request(orgPath("/api/org/security", orgId), { method: "PUT", body: JSON.stringify(policy) });
}

export function getPlatformSecurity() {
  return request("/api/platform/staff/security");
}

export function savePlatformSecurity(policy) {
  return request("/api/platform/staff/security", { method: "PUT", body: JSON.stringify(policy) });
}

// One person's devices, reached through their organization or, for platform
// staff, through the staff console. `scope` is { orgId } or { staff: true }.
function personPath(scope, userId, rest) {
  return scope.staff
    ? `/api/platform/staff/${userId}${rest}`
    : orgPath(`/api/org/users/${userId}${rest}`, scope.orgId);
}

export function getPersonSecurity(scope, userId) {
  return request(personPath(scope, userId, "/security"));
}

export function endPersonSession(scope, userId, sessionId) {
  return request(personPath(scope, userId, `/sessions/${encodeURIComponent(sessionId)}/end`), { method: "POST" });
}

export function signPersonOutEverywhere(scope, userId) {
  return request(personPath(scope, userId, "/sign-out-everywhere"), { method: "POST" });
}

export function decidePersonDevice(scope, userId, deviceId, decision) {
  return request(personPath(scope, userId, `/devices/${deviceId}/${decision}`), { method: "POST" });
}

export function setPersonPhone(scope, userId, allowed) {
  return request(personPath(scope, userId, "/phone"), { method: "PUT", body: JSON.stringify({ allowed }) });
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
// Off signs the company's tk4849 watcher out; its radios' online status then
// comes from their own heartbeats alone.
export function setOrganizationPresenceWatcher(id, enabled) {
  return request(`/api/organizations/${id}/radio/presence-watcher`, {
    method: "PUT",
    body: JSON.stringify({ enabled }),
  });
}

export function topUpOrganizationSeats(id) {
  return request(`/api/organizations/${id}/radio/seats`, { method: "POST" });
}

// Annual cards: the organization's card balance and every radio's and
// dispatcher's licence window, read live from the radio network.
export function getOrganizationLicences(id) {
  return request(`/api/organizations/${id}/licences`);
}

// { uids, years } spends cards; { uids, until, reason } sets the date with no
// card and is a platform owner's call.
export function rechargeOrganizationLicences(id, payload) {
  return request(`/api/organizations/${id}/licences/recharge`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function setOrganizationYearCards(id, yearCards) {
  return request(`/api/organizations/${id}/licences/cards`, {
    method: "PUT",
    body: JSON.stringify({ year_cards: yearCards }),
  });
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

// The /api/org endpoints act on the caller's own organization. Platform staff
// name the organization instead, so one organization page serves both: pass
// orgId when a platform admin is looking at someone else's.
function orgPath(path, orgId) {
  if (!orgId) return path;
  return `${path}${path.includes("?") ? "&" : "?"}organization_id=${encodeURIComponent(orgId)}`;
}

export function listOrgChannels(orgId) {
  return request(orgPath("/api/org/channels", orgId));
}

export function createOrgChannel(payload, orgId) {
  return request(orgPath("/api/org/channels", orgId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateOrgChannel(channelId, payload, orgId) {
  return request(orgPath(`/api/org/channels/${channelId}`, orgId), {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteOrgChannel(channelId, orgId) {
  return request(orgPath(`/api/org/channels/${channelId}`, orgId), { method: "DELETE" });
}

export function listOrgChannelDevices(channelId, orgId) {
  return request(orgPath(`/api/org/channels/${channelId}/devices`, orgId));
}

export function setOrgChannelDevice(channelId, deviceId, member, orgId) {
  return request(orgPath(`/api/org/channels/${channelId}/devices/${deviceId}`, orgId), {
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

export function getRadioNetwork() {
  return request("/api/pocstars/admin/network");
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

export function getPlatformStats(range = "7d") {
  return request(`/api/platform/stats?range=${encodeURIComponent(range)}`);
}

export function getServerStatus() {
  return request("/api/platform/stats/servers");
}

/**
 * How long this browser takes to reach the MOMAS server and back, in ms.
 * Sent without the session so the server takes its cheapest path and the
 * time is the trip itself.
 */
export async function pingServer() {
  const started = window.performance.now();
  const response = await fetch(`${config.apiBase}/api/health`, { cache: "no-store" });
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`The server answered ${response.status}`);
  return Math.round(window.performance.now() - started);
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

export function getOrgAdmin(orgId) {
  return request(orgPath("/api/org", orgId));
}

export function addOrgAdminUser(payload, orgId) {
  return request(orgPath("/api/org/users", orgId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function removeOrgAdminUser(userId, orgId) {
  return request(orgPath(`/api/org/users/${userId}`, orgId), {
    method: "DELETE",
  });
}

export function createOrgUnit(payload, orgId) {
  return request(orgPath("/api/org/units", orgId), {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateOrgUnit(unitId, payload, orgId) {
  return request(orgPath(`/api/org/units/${unitId}`, orgId), {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteOrgUnit(unitId, orgId) {
  return request(orgPath(`/api/org/units/${unitId}`, orgId), {
    method: "DELETE",
  });
}

export function assignDeviceUnit(deviceId, unitId, orgId) {
  return request(orgPath(`/api/org/devices/${encodeURIComponent(deviceId)}/unit`, orgId), {
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

export function reverseGeocode(lat, lon) {
  const query = new URLSearchParams({ lat, lon });
  return request(`/api/incidents/reverse-geocode?${query}`);
}

export function listDevices() {
  return request("/api/pocstars/devices");
}

// Platform only: the type puts a device in the Radio or Vehicle module.
export function setDeviceTypes(deviceIds, deviceType) {
  return request("/api/pocstars/devices/type", {
    method: "POST",
    body: JSON.stringify({ device_ids: deviceIds, device_type: deviceType }),
  });
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

// The trails behind several tracked radios, in one request: { tracks: { uid: points } }.
export function getRadioTracks(uids, minutes = 30) {
  const query = new URLSearchParams({ uids: uids.join(","), minutes: String(minutes) });
  return request(`/api/pocstars/locations/tracks?${query}`);
}

// One radio's points between two moments (epoch ms), for replaying its shift.
export function getRadioReplay(uid, from, to) {
  const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  return request(`/api/pocstars/locations/${encodeURIComponent(uid)}/replay?${query}`);
}

// Every radio's movement between two moments (epoch ms), for the Replay tab.
// Radios that stayed put come back as a summary without points.
export function getFleetReplay(from, to) {
  const query = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString() });
  return request(`/api/pocstars/positions/replay?${query}`);
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

// The radio list (which radios exist, their last fix, SOS flag). While the
// live points stream is connected the map moves radios from that stream, so
// the list only needs a slow backup refresh; when the stream is down, the
// list is all the map has and is asked for every 5 s.
export const RADIO_POLL_MS = 5_000;
export const RADIO_POLL_LIVE_MS = 15_000;

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

// The alerts feed, shared by every listener on the page (siren, radio bar,
// alarms list) so the tab holds one connection to it rather than three.
const alertsStream = createSharedEventSource({ getUrl: alertsEventsUrl, events: ["alert_new", "alert_updated"] });

export function subscribeAlerts(subscriber) {
  return alertsStream.subscribe(subscriber);
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

/** Units, channels, radios and drones a geofence rule can watch. */
export function getGeofenceTargets(organizationId) {
  const query = organizationId ? `?${new URLSearchParams({ organization_id: organizationId })}` : "";
  return request(`/api/geofences/targets${query}`);
}

export function searchPlaces(query) {
  return request(`/api/geofences/places?${new URLSearchParams({ q: query })}`);
}

/** Dry run: who each draft rule would find on the wrong side right now. */
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

/** OpenStreetMap places as you type; `osm` is set when the place has an outline. */
export function suggestPlaces(query) {
  return request(`/api/geofences/places/suggest?${new URLSearchParams({ q: query })}`);
}

/** The real outline of a place picked from suggestPlaces. */
export function getPlaceBorder(osm) {
  return request(`/api/geofences/places/border?${new URLSearchParams({ osm })}`);
}
