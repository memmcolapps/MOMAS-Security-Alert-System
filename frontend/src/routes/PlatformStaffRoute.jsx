import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import {
  createPlatformStaff,
  getPlatformStaff,
  removePlatformStaff,
  updatePlatformStaffRole,
} from "../lib/api";

// What each tier may do, in the words an owner would use to decide. The backend
// is the authority (see PLATFORM_RANK in auth.ts); this is the explanation.
const ROLE_HELP = {
  admin: "Everything, including adding platform users, deleting a company, and changing seat counts.",
  ops: "Runs the estate: create companies, onboard and allocate radios, assign channels, manage company users.",
  support: "Reads every company - radios, alarms, OSINT, drones - and changes nothing.",
};

const ROLE_STYLE = {
  admin: "border-ops-red/40 bg-red-500/10 text-ops-red",
  ops: "border-amber-500/30 bg-amber-500/10 text-amber-200",
  support: "border-white/15 bg-white/[0.05] text-neutral-300",
};

const emptyInvite = { email: "", name: "", password: "", platform_role: "support" };

export function PlatformStaffRoute() {
  const queryClient = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState(emptyInvite);
  const [error, setError] = useState(null);
  const [confirmRemove, setConfirmRemove] = useState(null);

  const staffQuery = useQuery({ queryKey: ["platform-staff"], queryFn: getPlatformStaff });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["platform-staff"] });
  const onError = (mutationError) => setError(mutationError?.message || "That did not work.");

  const inviteMutation = useMutation({
    mutationFn: createPlatformStaff,
    onSuccess: () => {
      setInvite(emptyInvite);
      setInviting(false);
      setError(null);
      refresh();
    },
    onError,
  });

  const roleMutation = useMutation({
    mutationFn: ({ id, role }) => updatePlatformStaffRole(id, role),
    onSuccess: () => {
      setError(null);
      refresh();
    },
    onError,
  });

  const removeMutation = useMutation({
    mutationFn: (id) => removePlatformStaff(id),
    onSuccess: () => {
      setConfirmRemove(null);
      setError(null);
      refresh();
    },
    onError,
  });

  const staff = useMemo(() => staffQuery.data?.staff || [], [staffQuery.data?.staff]);
  const roles = staffQuery.data?.roles || [];
  const audit = staffQuery.data?.audit || [];
  const myId = staffQuery.data?.me ?? null;
  const owners = staff.filter((person) => person.platform_role === "admin").length;

  return (
    <main className="device-page bg-ops-bg px-6 pb-8 pt-20 text-neutral-200">
      <header className="mb-7 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ops-red">
            <ShieldCheck size={22} /> Platform team
          </h1>
          <p className="mt-1 text-[11px] text-neutral-500">
            Accounts that sit above every company. They hold no company membership and see all tenants.
          </p>
        </div>
        <button
          className="inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85"
          onClick={() => {
            setInviting((value) => !value);
            setError(null);
          }}
        >
          {inviting ? <X size={14} /> : <Plus size={14} />}
          {inviting ? "Cancel" : "Add platform user"}
        </button>
      </header>

      {error ? (
        <div className="mb-5 rounded border border-ops-red/30 bg-red-500/10 px-3 py-2 text-xs text-ops-red">{error}</div>
      ) : null}

      {inviting ? (
        <form
          className="mb-7 rounded-lg border border-white/10 bg-white/[0.02] p-4"
          onSubmit={(event) => {
            event.preventDefault();
            inviteMutation.mutate(invite);
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Email">
              <input
                className="field-input"
                type="email"
                required
                value={invite.email}
                onChange={(event) => setInvite({ ...invite, email: event.target.value })}
              />
            </Field>
            <Field label="Name">
              <input
                className="field-input"
                value={invite.name}
                onChange={(event) => setInvite({ ...invite, name: event.target.value })}
              />
            </Field>
            <Field label="Temporary password">
              <input
                className="field-input"
                type="text"
                minLength={8}
                required
                value={invite.password}
                onChange={(event) => setInvite({ ...invite, password: event.target.value })}
              />
            </Field>
            <Field label="Role">
              <select
                className="field-input"
                value={invite.platform_role}
                onChange={(event) => setInvite({ ...invite, platform_role: event.target.value })}
              >
                {(roles.length ? roles : [{ role: "support", label: "Support" }]).map((role) => (
                  <option key={role.role} value={role.role}>
                    {role.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <p className="mt-3 flex items-start gap-2 text-[11px] text-neutral-500">
            <KeyRound size={13} className="mt-0.5 shrink-0" />
            <span>
              {ROLE_HELP[invite.platform_role]} They must change this password at first sign-in.
            </span>
          </p>

          <button
            className="mt-4 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50"
            disabled={inviteMutation.isPending}
            type="submit"
          >
            {inviteMutation.isPending ? "Adding…" : "Add to platform team"}
          </button>
        </form>
      ) : null}

      <section className="rounded-lg border border-white/10 bg-white/[0.02]">
        {staffQuery.isLoading ? (
          <p className="px-4 py-6 text-xs text-neutral-500">Loading…</p>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="text-[10px] uppercase tracking-wide text-neutral-500">
              <tr className="border-b border-white/10">
                <th className="px-4 py-2 font-bold">Person</th>
                <th className="px-4 py-2 font-bold">Role</th>
                <th className="px-4 py-2 font-bold">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {staff.map((person) => {
                const isMe = Number(person.id) === Number(myId);
                // The backend refuses both of these too; disabling them here is
                // so the reason is visible before the click, not after it.
                const lastOwner = person.platform_role === "admin" && owners <= 1;
                const locked = isMe || lastOwner;
                return (
                  <tr key={person.id} className="border-b border-white/5 last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-bold text-neutral-200">{person.name || person.email}</div>
                      <div className="text-[11px] text-neutral-500">{person.email}</div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        className={`rounded border px-2 py-1 text-[11px] font-bold disabled:opacity-60 ${
                          ROLE_STYLE[person.platform_role] || ROLE_STYLE.support
                        }`}
                        disabled={locked || roleMutation.isPending}
                        value={person.platform_role}
                        onChange={(event) => roleMutation.mutate({ id: person.id, role: event.target.value })}
                      >
                        {roles.map((role) => (
                          <option key={role.role} value={role.role} className="bg-black text-neutral-200">
                            {role.label}
                          </option>
                        ))}
                      </select>
                      <p className="mt-1 max-w-md text-[10px] text-neutral-600">{ROLE_HELP[person.platform_role]}</p>
                    </td>
                    <td className="px-4 py-3 text-[11px] text-neutral-400">
                      {person.must_change_password ? (
                        <span className="text-amber-200">Password not set yet</span>
                      ) : (
                        person.status
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {isMe ? (
                        <span className="text-[10px] text-neutral-600">This is you</span>
                      ) : lastOwner ? (
                        <span className="text-[10px] text-neutral-600">Last owner</span>
                      ) : confirmRemove === person.id ? (
                        <span className="inline-flex items-center gap-2">
                          <button
                            className="rounded bg-ops-red px-2 py-1 text-[10px] font-bold text-black"
                            disabled={removeMutation.isPending}
                            onClick={() => removeMutation.mutate(person.id)}
                          >
                            Confirm
                          </button>
                          <button
                            className="text-[10px] text-neutral-500 hover:text-neutral-300"
                            onClick={() => setConfirmRemove(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-ops-red"
                          onClick={() => setConfirmRemove(person.id)}
                        >
                          <Trash2 size={12} /> Remove
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {!staff.length ? (
                <tr>
                  <td className="px-4 py-6 text-xs text-neutral-500" colSpan={4}>
                    No platform users yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        )}
      </section>

      {/* Platform-level audit rows carry no organization, so they appear in no
          company's audit panel. This is the only place they are readable. */}
      <section className="mt-7">
        <h2 className="mb-2 text-xs font-bold uppercase tracking-wide text-neutral-400">Platform activity</h2>
        <div className="rounded-lg border border-white/10 bg-white/[0.02] divide-y divide-white/5">
          {audit.length ? (
            audit.map((entry) => (
              <div key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 px-4 py-2 text-[11px]">
                <span className="font-bold text-neutral-300">{entry.action}</span>
                <span className="text-neutral-500">
                  {entry.metadata?.email || entry.target_id ? `· ${entry.metadata?.email || entry.target_id}` : ""}
                </span>
                <span className="ml-auto text-neutral-600">
                  {entry.actor_email || "removed user"} · {new Date(entry.created_at).toLocaleString()}
                </span>
              </div>
            ))
          ) : (
            <p className="px-4 py-6 text-xs text-neutral-500">Nothing recorded yet.</p>
          )}
        </div>
      </section>
    </main>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-bold uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
