import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Radio, RadioTower, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { deleteOrganization, getMe, getOrganization, getOrganizationDeletionImpact, promoteOrganization, provisionOrganizationRadio, setOrganizationPresenceWatcher, topUpOrganizationSeats, updateOrganizationAccess } from "../../lib/api";
import { NIGERIAN_STATES } from "../../lib/domain";
import { isPlatformOperator, isPlatformOwner } from "../../lib/platform-roles";

// Support can open this page - reading every tenant is the point of the tier -
// so each section asks what the viewer may change rather than assuming the
// answer is "everything". The query is shared with the header by its key.
function usePlatformTier() {
  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: getMe,
    staleTime: 60_000,
  });
  const user = meQuery.data?.user;
  return { canWrite: isPlatformOperator(user), canOwn: isPlatformOwner(user) };
}


// The platform's own controls for one organization: who it is and what it may
// see, its place on the radio network, its seats and online watcher, and the
// irreversible acts. Everything the organization arranges for itself - radios,
// channels, units, people - lives in the tabs it shares with its own admins.
export function PlatformTab({ orgId, devices = [] }) {
  const queryClient = useQueryClient();
  const orgQuery = useQuery({
    queryKey: ["organization", orgId],
    queryFn: () => getOrganization(orgId),
    enabled: Number.isFinite(orgId),
  });
  // Drafts are kept per section; nothing here switches tabs under them, so the
  // dirty flag only needs somewhere to go.
  const noteDirty = useCallback(() => {}, []);
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["organization", orgId] });
    queryClient.invalidateQueries({ queryKey: ["organizations"] });
    queryClient.invalidateQueries({ queryKey: ["org-admin", orgId] });
    queryClient.invalidateQueries({ queryKey: ["me"] });
  };

  if (orgQuery.isLoading) {
    return (
      <div className="space-y-5">
        {[0, 1, 2].map((key) => <div key={key} className="glass-panel h-40 animate-pulse rounded-lg" />)}
      </div>
    );
  }
  if (orgQuery.error) return <p className="text-xs text-ops-red">{orgQuery.error.message}</p>;
  const organization = orgQuery.data?.organization;
  if (!organization) return <p className="text-xs text-neutral-500">This organization could not be found.</p>;

  return (
    <section className="space-y-5">
      {organization.status === "discovered" ? <PromotePanel organization={organization} /> : null}
      <OverviewSection organization={organization} onSaved={refresh} onDirtyChange={noteDirty} />
      <RadioSection organization={organization} devices={devices} onSaved={refresh} onDirtyChange={noteDirty} />
      <DangerZone organization={organization} />
    </section>
  );
}

// Identity, status and intelligence access in one place - they were split
// across two tabs called "Access" and "Settings" for four fields.
function OverviewSection({ organization, onSaved, onDirtyChange }) {
  const { canWrite } = usePlatformTier();
  const initial = useMemo(
    () => ({
      name: organization.name,
      status: organization.status,
      all_states: Boolean(organization.all_states),
      states: organization.states || [],
      modules: organization.modules?.length ? [...organization.modules].sort() : ["radio", "drone", "osint", "geofence"],
    }),
    [organization],
  );
  const [draft, setDraft] = useState(initial);

  // States are compared as a set. The API returns them alphabetically, the
  // checkboxes collect them in the order they were clicked, and comparing those
  // two as JSON left the form claiming unsaved changes after a clean save.
  const changed = (next) =>
    next.name !== initial.name ||
    next.status !== initial.status ||
    Boolean(next.all_states) !== initial.all_states ||
    [...(next.states || [])].sort().join("|") !==
      [...initial.states].sort().join("|") ||
    [...(next.modules || [])].sort().join("|") !== initial.modules.join("|");

  const edit = (next) => {
    setDraft(next);
    onDirtyChange(changed(next));
  };

  useEffect(() => {
    setDraft(initial);
    onDirtyChange(false);
  }, [initial, onDirtyChange]);

  const mutation = useMutation({
    mutationFn: (payload) => updateOrganizationAccess(organization.id, payload),
    onSuccess: onSaved,
  });
  const dirty = changed(draft);

  return (
    <section className="space-y-5">
      <div className="glass-panel rounded-lg p-5">
        <h2 className="mb-4 text-[13px] font-bold text-ops-red">Organization</h2>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Name">
            <input
              className="field-input"
              value={draft.name}
              onChange={(event) => edit({ ...draft, name: event.target.value })}
            />
          </Field>
          <Field label="Status">
            <select
              className="field-input"
              value={draft.status}
              onChange={(event) =>
                edit({ ...draft, status: event.target.value })
              }
            >
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
            </select>
          </Field>
        </div>
        <p className="text-[11px] text-neutral-500">
          Suspending keeps everything intact and blocks the organization from using
          the platform. Slug{" "}
          <span className="font-mono text-neutral-400">
            {organization.slug}
          </span>{" "}
          is fixed once created.
        </p>

        <h3 className="mb-1 mt-5 text-[12px] font-bold text-ops-red">
          Intelligence access
        </h3>
        <p className="mb-3 text-[11px] text-neutral-500">
          Which Nigerian states this organization sees in the operations console.
        </p>
        <StatePicker value={draft} onChange={edit} />

        <h3 className="mb-1 mt-5 text-[12px] font-bold text-ops-red">Available modules</h3>
        <p className="mb-3 text-[11px] text-neutral-500">Choose which modules this organization can open. At least one must remain enabled.</p>
        <div className="flex flex-wrap gap-2">
          {[["radio", "Radio"], ["drone", "Drone"], ["osint", "OSINT"], ["geofence", "Geofence"]].map(([value, label]) => {
            const checked = draft.modules.includes(value);
            return (
              <label key={value} className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-xs ${checked ? "border-ops-red/50 bg-red-500/10 text-neutral-100" : "border-white/10 bg-white/[0.02] text-neutral-400"}`}>
                <input
                  type="checkbox"
                  className="accent-red-500"
                  checked={checked}
                  disabled={checked && draft.modules.length === 1}
                  onChange={() => edit({
                    ...draft,
                    modules: checked
                      ? draft.modules.filter((module) => module !== value)
                      : [...draft.modules, value],
                  })}
                />
                {label}
              </label>
            );
          })}
        </div>

        <SaveRow
          mutation={mutation}
          dirty={dirty}
          onSave={() => mutation.mutate(draft)}
          label="Save organization"
          allowed={canWrite}
          deniedNote="Your role can view this organization but not change it."
        />
      </div>

    </section>
  );
}

// Every save on this page reports the same way. Access used to confirm,
// Settings said nothing at all, so you could not tell a saved edit from a
// dropped one.
function SaveRow({
  mutation,
  dirty,
  onSave,
  label,
  allowed = true,
  deniedNote,
}) {
  if (!allowed) {
    return <p className="mt-4 text-[11px] text-neutral-500">{deniedNote}</p>;
  }
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button
        className="inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
        disabled={mutation.isPending || !dirty}
        onClick={onSave}
      >
        <Save size={13} /> {mutation.isPending ? "Saving…" : label}
      </button>
      {dirty ? (
        <span className="text-[11px] text-amber-300">Unsaved changes</span>
      ) : null}
      {mutation.error ? (
        <span className="text-xs text-ops-red">{mutation.error.message}</span>
      ) : null}
      {mutation.isSuccess && !dirty ? (
        <span className="text-xs text-ops-green">Saved</span>
      ) : null}
    </div>
  );
}

// Its place on the radio network: whether it exists there, how many concurrent
// sessions it may hold, and where its online status comes from.
function RadioSection({
  organization,
  devices,
  onSaved,
  onDirtyChange,
}) {
  const { canWrite, canOwn } = usePlatformTier();
  const initial = useMemo(
    () => ({
      radio_seats: Number(organization.radio_seats ?? 2),
      platform_radio_seats: Number(organization.platform_radio_seats ?? 1),
    }),
    [organization],
  );
  const [draft, setDraft] = useState(initial);

  // A number input hands back a string, and the API hands back a number, so
  // comparing the two as JSON reported "Unsaved changes" forever after any
  // edit - including a save that had gone through perfectly.
  const changed = (next) =>
    Number(next.radio_seats) !== initial.radio_seats ||
    Number(next.platform_radio_seats) !== initial.platform_radio_seats;

  const edit = (next) => {
    setDraft(next);
    onDirtyChange(changed(next));
  };

  // The saved record comes back through the query, so the form has to follow it
  // rather than keep showing what was typed.
  useEffect(() => {
    setDraft(initial);
    onDirtyChange(false);
  }, [initial, onDirtyChange]);

  const seatsMutation = useMutation({
    mutationFn: (payload) =>
      updateOrganizationAccess(organization.id, {
        // Sent as numbers: the backend clamps with Math.max, and "5" would work
        // there by coercion, but nothing downstream should depend on that.
        radio_seats: Number(payload.radio_seats),
        platform_radio_seats: Number(payload.platform_radio_seats),
      }),
    onSuccess: onSaved,
  });
  const provisionMutation = useMutation({
    mutationFn: () => provisionOrganizationRadio(organization.id),
    onSuccess: onSaved,
  });
  const dirty = changed(draft);

  return (
    <section className="space-y-5">
      <div className="glass-panel rounded-lg p-5">
        <h2 className="text-[13px] font-bold text-ops-green">Radio network</h2>
        {organization.pocstars_company_id ? (
          <p className="mt-1 text-[11px] text-neutral-500">
            Linked to radio network company{" "}
            <span className="font-mono text-neutral-300">
              {organization.pocstars_company_id}
            </span>
            {organization.pocstars_company_name
              ? ` · ${organization.pocstars_company_name}`
              : ""}
            . Its dispatcher seats and channels are its own.
          </p>
        ) : (
          <>
            <p className="mt-1 max-w-2xl text-[11px] text-amber-200">
              This organization has no company on the radio network, so it
              cannot hold channels or radios. This usually means the setup
              failed when the organization was created.
            </p>
            <button
              hidden={!canWrite}
              className="mt-3 inline-flex items-center gap-2 rounded bg-ops-green px-4 py-2 text-xs font-bold text-black disabled:opacity-50"
              disabled={provisionMutation.isPending}
              onClick={() => provisionMutation.mutate()}
            >
              <RadioTower size={13} />
              {provisionMutation.isPending
                ? "Setting up…"
                : "Set up on the radio network"}
            </button>
            {provisionMutation.error ? (
              <p className="mt-2 text-xs text-ops-red">
                {provisionMutation.error.message}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="glass-panel rounded-lg p-5">
        <h2 className="mb-1 text-[13px] font-bold text-ops-red">Seats</h2>
        <p className="mb-4 text-[11px] text-neutral-500">
          How many audio sessions can run at once. Platform seats are reserved
          for us, so our monitoring never consumes theirs. Saving here changes
          the allowance in MOMAS only; use the button below to create the
          matching dispatcher seats on the radio network.
        </p>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Radio seats (their concurrent audio sessions)">
            <input
              className="field-input"
              type="number"
              min="1"
              value={draft.radio_seats}
              onChange={(event) =>
                edit({ ...draft, radio_seats: event.target.value })
              }
            />
          </Field>
          <Field label="Platform seats (reserved for us)">
            <input
              className="field-input"
              type="number"
              min="0"
              value={draft.platform_radio_seats}
              onChange={(event) =>
                edit({ ...draft, platform_radio_seats: event.target.value })
              }
            />
          </Field>
        </div>
        {/* Seats are what this install is billed for, so they are the owner's
            alone - the backend refuses them from any other tier. */}
        <SaveRow
          mutation={seatsMutation}
          dirty={dirty}
          onSave={() => seatsMutation.mutate(draft)}
          label="Save seats"
          allowed={canOwn}
          deniedNote="Only a platform owner can change seat counts."
        />
        {/* Raising the allowance above is a MOMAS number; the radio network only
            hands out consoles it actually has. This provisions the shortfall,
            and does nothing when there isn't one. */}
        {canWrite && organization.pocstars_company_id ? (
          <SeatTopUpButton organization={organization} />
        ) : null}
      </div>

      {organization.pocstars_company_id ? (
        <OnlineStatusPanel
          organization={organization}
          devices={devices}
          canWrite={canWrite}
        />
      ) : null}

    </section>
  );
}


// Deletion is the only irreversible act on this page, so it is staged: open the
// panel, read what actually goes, then type the name. Suspending is offered
// alongside because it is what most people reaching for delete actually want.
function DangerZone({ organization }) {
  const { canOwn } = usePlatformTier();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");

  const impactQuery = useQuery({
    queryKey: ["organization-deletion-impact", organization.id],
    queryFn: () => getOrganizationDeletionImpact(organization.id),
    enabled: open,
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteOrganization(organization.id, confirmation.trim()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
      queryClient.invalidateQueries({ queryKey: ["pocstars-registry"] });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      navigate({ to: "/admin/organizations" });
    },
  });

  const counts = impactQuery.data?.counts;
  const radio = impactQuery.data?.radio;
  const matches = confirmation.trim() === organization.name.trim();

  // Nothing here is recoverable, so the panel is not shown at all below the
  // owner tier - a disabled delete button still invites the attempt.
  if (!canOwn) return null;

  return (
    <div className="mt-6 rounded-lg border border-red-500/30 bg-red-500/[0.04] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-[12px] font-bold text-ops-red">
            <AlertTriangle size={14} /> Delete this organization
          </h3>
          <p className="mt-1 max-w-2xl text-[11px] text-neutral-500">
            Removes the workspace and everything filed under it. Its radios
            return to the unallocated pool. To stop it using the platform
            without losing its data, set its status to Suspended above instead.
          </p>
        </div>
        <button
          className="shrink-0 rounded border border-red-500/30 px-3 py-2 text-[11px] font-bold text-red-300 hover:border-ops-red hover:text-ops-red"
          onClick={() => {
            setOpen((value) => !value);
            setConfirmation("");
            deleteMutation.reset();
          }}
        >
          {open ? "Cancel" : "Delete organization"}
        </button>
      </div>

      {open ? (
        <div className="mt-4 border-t border-red-500/20 pt-4">
          {impactQuery.isLoading ? (
            <p className="text-[11px] text-neutral-500">
              Checking what this would remove…
            </p>
          ) : impactQuery.error ? (
            <p className="text-[11px] text-ops-red">
              {impactQuery.error.message}
            </p>
          ) : counts ? (
            <>
              <p className="text-[11px] font-bold text-neutral-300">
                Deleting {organization.name} will:
              </p>
              <ul className="mt-2 space-y-1 text-[11px] text-neutral-400">
                <ImpactLine
                  count={counts.radios}
                  one="radio returns"
                  many="radios return"
                  tail="to the unallocated pool"
                />
                <ImpactLine
                  count={counts.claimed_groups}
                  one="radio channel is released"
                  many="radio channels are released"
                  tail="back to the network registry"
                />
                <ImpactLine
                  count={counts.members}
                  one="admin loses access"
                  many="admins lose access"
                />
                <ImpactLine
                  count={counts.accounts_deleted}
                  one="login is deleted"
                  many="logins are deleted"
                  tail="(they belong to no other organization)"
                />
                <ImpactLine
                  count={counts.units}
                  one="unit is deleted"
                  many="units are deleted"
                />
                <ImpactLine
                  count={counts.channels}
                  one="channel record is deleted"
                  many="channel records are deleted"
                />
                <ImpactLine
                  count={counts.geofences}
                  one="geofence is deleted"
                  many="geofences are deleted"
                />
                <ImpactLine
                  count={counts.alerts}
                  one="alert is deleted"
                  many="alerts are deleted"
                />
                <ImpactLine
                  count={counts.audit_entries}
                  one="audit entry is deleted"
                  many="audit entries are deleted"
                />
              </ul>
              {radio?.company_id ? (
                <p className="mt-3 rounded border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">
                  Radio network company {radio.company_id} is left in place —
                  the network is shared with other operators and keeps its
                  recordings. Retire it on the network itself if it is no longer
                  needed.
                  {radio.shared_with?.length
                    ? ` It is also claimed by ${radio.shared_with.map((org) => org.name).join(", ")}.`
                    : ""}
                </p>
              ) : null}
            </>
          ) : null}

          <label className="mt-4 flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">
              Type{" "}
              <span className="font-bold text-neutral-300">
                {organization.name}
              </span>{" "}
              to confirm
            </span>
            <input
              className="field-input"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              placeholder={organization.name}
              autoComplete="off"
            />
          </label>

          {deleteMutation.error ? (
            <p className="mt-2 text-[11px] text-ops-red">
              {deleteMutation.error.message}
            </p>
          ) : null}

          <button
            className="mt-3 inline-flex items-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-40"
            disabled={
              !matches || deleteMutation.isPending || impactQuery.isLoading
            }
            onClick={() => deleteMutation.mutate()}
          >
            <Trash2 size={13} />
            {deleteMutation.isPending
              ? "Deleting…"
              : `Permanently delete ${organization.name}`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ImpactLine({ count, one, many, tail }) {
  if (!count) return null;
  return (
    <li className="flex gap-2">
      <span className="text-neutral-600">•</span>
      <span>
        <span className="font-bold text-neutral-200">{count}</span>{" "}
        {count === 1 ? one : many}
        {tail ? ` ${tail}` : ""}
      </span>
    </li>
  );
}

function Field({ label, children }) {
  return (
    <label className="mb-3 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">
        {label}
      </span>
      {children}
    </label>
  );
}

function StatePicker({ value, onChange }) {
  const states = value.states || [];
  const toggleState = (state) => {
    const next = states.includes(state)
      ? states.filter((item) => item !== state)
      : [...states, state];
    onChange({ ...value, states: next, all_states: false });
  };
  return (
    <div>
      <label className="mb-3 flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="checkbox"
          checked={Boolean(value.all_states)}
          onChange={(event) =>
            onChange({ ...value, all_states: event.target.checked })
          }
        />
        All states
      </label>
      {!value.all_states ? (
        <div className="grid max-h-52 grid-cols-2 gap-2 overflow-y-auto rounded border border-white/10 bg-white/[0.03] p-3 md:grid-cols-3">
          {NIGERIAN_STATES.map((state) => (
            <label
              className="flex items-center gap-2 text-[11px] text-neutral-400"
              key={state}
            >
              <input
                type="checkbox"
                checked={states.includes(state)}
                onChange={() => toggleState(state)}
              />
              {state}
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// Taking on a company the radio-network sync discovered. It sits at the top of
// the page because until it is answered every other tab on this page is
// read-only: MOMAS can see the company's radios but must not add users, touch
// its channels, or lease its consoles.
//
// The seat question is asked here rather than assumed, because this is the
// moment the number stops describing what the vendor sold the company and
// starts being an allocation MOMAS owns and must provision.
function PromotePanel({ organization }) {
  const { canOwn } = usePlatformTier();
  const queryClient = useQueryClient();
  const vendorSeats = Math.max(1, Number(organization.radio_seats) || 1);
  const [tenantSeats, setTenantSeats] = useState(
    String(Math.max(2, vendorSeats)),
  );
  const [platformSeats, setPlatformSeats] = useState("1");
  const [result, setResult] = useState(null);

  const promoteMutation = useMutation({
    mutationFn: () =>
      promoteOrganization(organization.id, {
        radio_seats: Number(tenantSeats),
        platform_radio_seats: Number(platformSeats),
      }),
    onSuccess: (response) => {
      setResult(response || null);
      queryClient.invalidateQueries({
        queryKey: ["organization", String(organization.id)],
      });
      queryClient.invalidateQueries({ queryKey: ["organizations"] });
    },
  });

  return (
    <section className="mt-3 rounded-lg border border-sky-400/30 bg-sky-400/[0.06] p-4">
      <h2 className="flex items-center gap-2 text-[13px] font-bold text-sky-200">
        <RadioTower size={14} /> Discovered on the radio network
      </h2>
      <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-neutral-400">
        The sync found this organization on the shared radio network and imported its
        radios so you can see them. MOMAS does not operate it: nobody can be
        given a login here, its channels cannot be changed, and its dispatcher
        consoles cannot be used. Promoting it says MOMAS runs this organization from
        now on.
      </p>
      <p className="mt-2 max-w-3xl text-[11px] leading-relaxed text-neutral-500">
        The radio network gave it{" "}
        <strong className="text-neutral-300">{vendorSeats}</strong> dispatcher
        seat{vendorSeats === 1 ? "" : "s"}. A seat is taken for the whole of a
        private call, so a control room on one seat is deaf to its own channel
        while calling. Any extra seats you ask for here are created on the radio
        network as part of promoting.
      </p>

      {canOwn ? (
        <>
          <div className="mt-3 grid max-w-lg gap-3 sm:grid-cols-2">
            <Field label="Control room seats">
              <input
                className="field-input"
                type="number"
                min="1"
                value={tenantSeats}
                onChange={(event) => setTenantSeats(event.target.value)}
              />
            </Field>
            <Field label="Platform seats">
              <input
                className="field-input"
                type="number"
                min="0"
                value={platformSeats}
                onChange={(event) => setPlatformSeats(event.target.value)}
              />
            </Field>
          </div>
          <button
            className="mt-3 inline-flex items-center gap-2 rounded-md bg-sky-400/90 px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50"
            disabled={promoteMutation.isPending}
            onClick={() => {
              setResult(null);
              promoteMutation.mutate();
            }}
          >
            <RadioTower size={14} />
            {promoteMutation.isPending
              ? "Promoting…"
              : `Promote ${organization.name}`}
          </button>
        </>
      ) : (
        <p className="mt-3 text-[11px] text-neutral-500">
          Only a platform owner can promote an organization.
        </p>
      )}

      {promoteMutation.error ? (
        <p className="mt-2 text-[11px] text-ops-red">
          {promoteMutation.error.message}
        </p>
      ) : null}
      {result?.warning ? (
        // The status change succeeded and the seat provisioning did not. Saying
        // so plainly matters: the company is live but short of seats, and the
        // Radio tab's top-up is the retry.
        <p className="mt-2 flex items-center gap-2 text-[11px] text-amber-300">
          <AlertTriangle size={12} className="shrink-0" /> {result.warning}
        </p>
      ) : null}
      {result && !result.warning ? (
        <p className="mt-2 text-[11px] text-ops-green">
          Promoted.
          {result.seats?.seats?.length
            ? ` ${result.seats.seats.length} dispatcher seat${result.seats.seats.length === 1 ? "" : "s"} added on the radio network.`
            : " The radio network already had enough dispatcher seats."}
        </p>
      ) : null}
    </section>
  );
}

// Retry or top-up after the allowance was raised. Idempotent on the server, so
// pressing it when nothing is missing is harmless.
// Where this company's online dots come from. Radios report their own status
// about every 15 seconds; the tk4849 watcher also covers radios that never send
// those reports, at the price of a stranger in every channel's member list.
function OnlineStatusPanel({ organization, devices, canWrite }) {
  const queryClient = useQueryClient();
  const key = ["organization", Number(organization.id)];
  const enabled = organization.presence_watcher_enabled !== false;
  const discovered = organization.status === "discovered";
  // Online right now only because the watcher sees them: these are the radios
  // that switching it off would show as offline.
  const watcherOnly = (devices || []).filter(
    (device) =>
      device.pocstars_managed &&
      device.active &&
      device.pocstars_online &&
      !(
        device.heartbeat_at &&
        Date.now() - Date.parse(device.heartbeat_at) < 75_000
      ),
  ).length;

  // The switch moves at once; the server catches up, and a refusal puts it back.
  const mutation = useMutation({
    mutationFn: (next) => setOrganizationPresenceWatcher(organization.id, next),
    onMutate: async (next) => {
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData(key);
      queryClient.setQueryData(
        key,
        (data) =>
          data && {
            ...data,
            organization: {
              ...data.organization,
              presence_watcher_enabled: next,
            },
          },
      );
      return { previous };
    },
    onError: (_error, _next, context) => {
      if (context?.previous) queryClient.setQueryData(key, context.previous);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  return (
    <div className="glass-panel rounded-lg p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[13px] font-bold text-ops-red">Online status</h2>
          <p className="mt-1 max-w-2xl text-[11px] text-neutral-500">
            Radios report their battery and signal about every 15 seconds, and
            that is enough to show them online. The watcher adds the radios that
            never send these reports. While on, it is a member called tk4849 in
            every one of this company&apos;s channels; turning it off removes it
            from all of them.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Watcher"
          disabled={!canWrite || mutation.isPending}
          onClick={() => mutation.mutate(!enabled)}
          className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
            enabled ? "bg-ops-green" : "bg-white/15"
          }`}
        >
          <span
            className={`absolute left-0 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
              enabled ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>
      <p className="mt-3 text-[11px] text-neutral-400">
        {discovered
          ? "Not operated by MOMAS yet, so no watcher runs here. Online status comes from radio reports."
          : enabled
            ? "Watcher on: a radio is online when it reports or the watcher sees it."
            : "Watcher off: tk4849 is in none of the channels, and a radio is online only while it is reporting."}
      </p>
      {!discovered && enabled && watcherOnly ? (
        <p className="mt-1 text-[11px] text-amber-300/90">
          {watcherOnly} online radio{watcherOnly === 1 ? " is" : "s are"} not
          sending reports and would show offline with the watcher off.
        </p>
      ) : null}
      {mutation.error ? (
        <p className="mt-2 text-xs text-ops-red">{mutation.error.message}</p>
      ) : null}
    </div>
  );
}

function SeatTopUpButton({ organization }) {
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const mutation = useMutation({
    mutationFn: () => topUpOrganizationSeats(organization.id),
    onSuccess: (response) => {
      setMessage(
        response?.warning ||
          (response?.seats?.seats?.length
            ? `${response.seats.seats.length} seat(s) added on the radio network.`
            : "The radio network already has enough dispatcher seats."),
      );
      queryClient.invalidateQueries({
        queryKey: ["organization", String(organization.id)],
      });
    },
  });
  return (
    <div className="mt-2">
      <button
        className="rounded-md border border-white/15 px-3 py-1.5 text-[11px] font-bold text-neutral-200 hover:bg-white/5 disabled:opacity-50"
        disabled={mutation.isPending}
        onClick={() => {
          setMessage("");
          mutation.mutate();
        }}
      >
        {mutation.isPending ? "Checking…" : "Match seats on the radio network"}
      </button>
      {message ? (
        <p className="mt-1 text-[11px] text-neutral-400">{message}</p>
      ) : null}
      {mutation.error ? (
        <p className="mt-1 text-[11px] text-ops-red">
          {mutation.error.message}
        </p>
      ) : null}
    </div>
  );
}
