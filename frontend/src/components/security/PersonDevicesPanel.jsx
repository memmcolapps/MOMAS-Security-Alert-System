import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  decidePersonDevice,
  endPersonSession,
  getPersonSecurity,
  setPersonPhone,
  signPersonOutEverywhere,
} from "../../lib/api";
import { PanelSection, SidePanel } from "../org/shared";
import { DeviceRows, SessionRows, SmallButton } from "./DeviceLists";

// One person's sign-ins and devices, as an admin sees them: sign a device out,
// sign them out everywhere, approve or block a device, report a phone lost,
// and allow or stop phone sign-in. `scope` is { orgId } or { staff: true }.

export function PersonDevicesPanel({ scope, person, phoneMode, onClose, onChanged }) {
  const queryClient = useQueryClient();
  const key = ["person-security", scope.staff ? "staff" : scope.orgId ?? "mine", person.id];
  const query = useQuery({ queryKey: key, queryFn: () => getPersonSecurity(scope, person.id), refetchInterval: 20_000 });
  const data = query.data || { sessions: [], devices: [], phone_allowed: true };

  // Each change shows at once and is rolled back if the server refuses it.
  const optimistic = (mutationFn, apply) => ({
    mutationFn,
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: key });
      const before = queryClient.getQueryData(key);
      if (before) queryClient.setQueryData(key, apply(before, variables));
      return { before };
    },
    onError: (_error, _variables, context) => queryClient.setQueryData(key, context?.before),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: key });
      onChanged?.();
    },
  });

  const endOne = useMutation(optimistic(
    (sessionId) => endPersonSession(scope, person.id, sessionId),
    (data, sessionId) => ({ ...data, sessions: data.sessions.filter((session) => session.id !== sessionId) }),
  ));
  const endAll = useMutation(optimistic(
    () => signPersonOutEverywhere(scope, person.id),
    (data) => ({ ...data, sessions: [] }),
  ));
  const decide = useMutation(optimistic(
    ({ deviceId, decision }) => decidePersonDevice(scope, person.id, deviceId, decision),
    (data, { deviceId, decision }) => ({
      ...data,
      devices: data.devices.map((device) =>
        device.id === deviceId ? { ...device, status: decision === "approve" ? "approved" : "blocked" } : device),
      sessions: decision === "approve" ? data.sessions : data.sessions.filter((session) => session.device_id !== deviceId),
    }),
  ));
  const phone = useMutation(optimistic(
    (allowed) => setPersonPhone(scope, person.id, allowed),
    (data, allowed) => ({
      ...data,
      phone_allowed: allowed,
      sessions: allowed ? data.sessions : data.sessions.filter((session) => !session.is_phone),
    }),
  ));
  const error = endOne.error || endAll.error || decide.error || phone.error || query.error;

  return (
    <SidePanel title={person.name || person.email} subtitle={`${person.email} · devices and sign-ins`} onClose={onClose}>
      {error ? <p className="mx-5 mt-4 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-300">{error.message}</p> : null}

      <PanelSection
        title={`Signed in now${query.isLoading ? "" : ` · ${data.sessions.length}`}`}
        action={data.sessions.length ? (
          <SmallButton danger disabled={endAll.isPending} onClick={() => endAll.mutate()}>Sign out everywhere</SmallButton>
        ) : null}
      >
        {query.isLoading ? <Loading /> : (
          <SessionRows
            showPanic
            sessions={data.sessions}
            actions={(session) => <SmallButton danger onClick={() => endOne.mutate(session.id)}>Sign out</SmallButton>}
          />
        )}
      </PanelSection>

      <PanelSection title="Devices">
        {query.isLoading ? <Loading /> : (
          <DeviceRows
            devices={data.devices}
            actions={(device) => (
              <>
                {device.status !== "approved" ? (
                  <SmallButton primary onClick={() => decide.mutate({ deviceId: device.id, decision: "approve" })}>Approve</SmallButton>
                ) : null}
                {device.status !== "blocked" ? (
                  <SmallButton danger onClick={() => decide.mutate({ deviceId: device.id, decision: "block" })}>Block</SmallButton>
                ) : null}
                {!scope.staff && device.status !== "blocked" && device.is_phone ? (
                  <SmallButton
                    danger
                    onClick={() => {
                      if (window.confirm(`Report "${device.label}" lost? It is signed out, blocked, and an amber alarm is raised.`)) {
                        decide.mutate({ deviceId: device.id, decision: "lost" });
                      }
                    }}
                  >
                    Lost
                  </SmallButton>
                ) : null}
              </>
            )}
          />
        )}
      </PanelSection>

      <PanelSection title="Phone sign-in">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-0.5 accent-ops-red"
            checked={data.phone_allowed}
            disabled={query.isLoading || phone.isPending}
            onChange={(event) => phone.mutate(event.target.checked)}
          />
          <span className="text-[12px] text-neutral-200">
            May sign in on a phone
            <span className="block text-[11px] text-neutral-500">
              {phoneMode === "chosen"
                ? "Turning this off also signs out any phone they are using now."
                : phoneMode === "nobody"
                  ? "Phones are off for everyone, so this has no effect until that changes."
                  : "Only applies when phone sign-in is set to chosen people. Turning it off signs out their phones now."}
            </span>
          </span>
        </label>
      </PanelSection>
    </SidePanel>
  );
}

function Loading() {
  return <div className="h-10 animate-pulse rounded bg-white/[0.05]" />;
}
