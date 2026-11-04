import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { addOrgAdminUser, createOrgUnit, deleteOrgUnit, removeOrgAdminUser } from "../../lib/api";
import { NIGERIAN_STATES, ORG_ROLES, orgRoleLabel } from "../../lib/domain";
import { Empty, Field, List, SkeletonRows, formatDateTime, plural, unitOptionLabel } from "./shared";

function useOrgRefresh(ctx) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ctx.orgKey });
}

function FormHeader({ title, onCancel }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <h2 className="text-[13px] font-bold text-neutral-100">{title}</h2>
      <button type="button" aria-label="Cancel" className="rounded p-1 text-neutral-500 hover:text-neutral-100" onClick={onCancel}>
        <X size={15} />
      </button>
    </div>
  );
}

const emptyUnit = { name: "", type: "", parent_unit_id: "", state: "", lga: "", location: "" };

export function UnitsTab({ ctx, units, loading }) {
  const refresh = useOrgRefresh(ctx);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptyUnit);
  const createMutation = useMutation({
    mutationFn: () => createOrgUnit({ ...form, parent_unit_id: form.parent_unit_id || null }, ctx.orgId),
    onSuccess: () => {
      setForm(emptyUnit);
      setCreating(false);
      refresh();
    },
  });

  return (
    <section className="space-y-4">
      {creating ? (
        <form
          className="glass-panel rounded-lg p-5"
          onSubmit={(event) => {
            event.preventDefault();
            createMutation.mutate();
          }}
        >
          <FormHeader title="New unit" onCancel={() => setCreating(false)} />
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Field label="Name">
              <input autoFocus className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </Field>
            <Field label="Label">
              <input className="field-input" value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })} placeholder="e.g. Station, Department" />
            </Field>
            <Field label="Inside">
              <select className="field-input" value={form.parent_unit_id} onChange={(event) => setForm({ ...form, parent_unit_id: event.target.value })}>
                <option value="">Top level</option>
                {units.map((unit) => <option value={unit.id} key={unit.id}>{unitOptionLabel(unit)}</option>)}
              </select>
            </Field>
            <Field label="State">
              <select className="field-input" value={form.state} onChange={(event) => setForm({ ...form, state: event.target.value })}>
                <option value="">Not state-bound</option>
                {NIGERIAN_STATES.map((state) => <option value={state} key={state}>{state}</option>)}
              </select>
            </Field>
            <Field label="LGA">
              <input className="field-input" value={form.lga} onChange={(event) => setForm({ ...form, lga: event.target.value })} />
            </Field>
            <Field label="Location">
              <input className="field-input" value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} />
            </Field>
          </div>
          {createMutation.error ? <p className="mt-3 text-xs text-ops-red">{createMutation.error.message}</p> : null}
          <button className="mt-4 inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50" disabled={createMutation.isPending}>
            <Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create unit"}
          </button>
        </form>
      ) : null}

      <List
        title={loading ? "Loading units…" : plural(units.length, "unit")}
        action={ctx.canManage && !creating ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-ops-red px-3 py-1.5 text-[11px] font-bold text-black hover:opacity-85"
            onClick={() => setCreating(true)}
          >
            <Plus size={12} /> New unit
          </button>
        ) : null}
      >
        {loading ? <SkeletonRows count={3} /> : null}
        {units.map((unit) => <UnitRow key={unit.id} ctx={ctx} unit={unit} onChanged={refresh} />)}
        {!loading && !units.length ? <Empty>No units yet. Units group people and radios, like stations or departments.</Empty> : null}
      </List>
    </section>
  );
}

function UnitRow({ ctx, unit, onChanged }) {
  const deleteMutation = useMutation({ mutationFn: () => deleteOrgUnit(unit.id, ctx.orgId), onSuccess: onChanged });
  return (
    <article className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm text-neutral-100">{unit.name}</h3>
        <p className="text-[11px] text-neutral-500">
          {unit.type || "Unit"} · {unit.parent_name ? `inside ${unit.parent_name}` : "top level"}
          {unit.state ? ` · ${unit.state}` : ""} · {plural(Number(unit.user_count) || 0, "person", "people")} · {plural(Number(unit.device_count) || 0, "radio")}
        </p>
        {deleteMutation.error ? <p className="mt-1 text-[11px] text-ops-red">{deleteMutation.error.message}</p> : null}
      </div>
      {ctx.canManage ? (
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md border border-red-500/20 px-2 py-1 text-[10px] text-red-400/80 hover:border-ops-red hover:text-ops-red"
          onClick={() => {
            if (window.confirm(`Remove ${unit.name}?`)) deleteMutation.mutate();
          }}
        >
          <Trash2 size={11} /> Remove
        </button>
      ) : null}
    </article>
  );
}

const emptyPerson = { email: "", name: "", password: "", role: "operator", unit_id: "", scope_level: "unit" };

export function PeopleTab({ ctx, users, units, loading }) {
  const refresh = useOrgRefresh(ctx);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyPerson);
  const addMutation = useMutation({
    mutationFn: () => addOrgAdminUser({
      ...form,
      unit_id: form.unit_id || null,
      scope_level: form.unit_id ? form.scope_level : "organization",
    }, ctx.orgId),
    onSuccess: () => {
      setForm(emptyPerson);
      setAdding(false);
      refresh();
    },
  });
  const removeMutation = useMutation({ mutationFn: (userId) => removeOrgAdminUser(userId, ctx.orgId), onSuccess: refresh });

  return (
    <section className="space-y-4">
      {adding ? (
        <form
          className="glass-panel rounded-lg p-5"
          onSubmit={(event) => {
            event.preventDefault();
            addMutation.mutate();
          }}
        >
          <FormHeader title="Add a person" onCancel={() => setAdding(false)} />
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            <Field label="Name"><input autoFocus className="field-input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></Field>
            <Field label="Email"><input className="field-input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></Field>
            <Field label="Temporary password"><input className="field-input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} /></Field>
            <Field label="Role">
              <select className="field-input" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                {ORG_ROLES.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
              </select>
            </Field>
            <Field label="Unit">
              <select className="field-input" value={form.unit_id} onChange={(event) => setForm({ ...form, unit_id: event.target.value })}>
                <option value="">Whole organization</option>
                {units.map((unit) => <option value={unit.id} key={unit.id}>{unitOptionLabel(unit)}</option>)}
              </select>
            </Field>
            {form.unit_id ? (
              <Field label="Can see">
                <select className="field-input" value={form.scope_level} onChange={(event) => setForm({ ...form, scope_level: event.target.value })}>
                  <option value="unit">Only this unit</option>
                  <option value="organization">The whole organization</option>
                </select>
              </Field>
            ) : null}
          </div>
          {addMutation.error ? <p className="mt-3 text-xs text-ops-red">{addMutation.error.message}</p> : null}
          <button className="mt-4 inline-flex items-center gap-2 rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black hover:opacity-85 disabled:opacity-50" disabled={addMutation.isPending}>
            <UserPlus size={14} /> {addMutation.isPending ? "Adding…" : "Add person"}
          </button>
        </form>
      ) : null}

      <List
        title={loading ? "Loading people…" : plural(users.length, "person", "people")}
        action={ctx.canManage && !adding ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-md bg-ops-red px-3 py-1.5 text-[11px] font-bold text-black hover:opacity-85"
            onClick={() => setAdding(true)}
          >
            <UserPlus size={12} /> Add person
          </button>
        ) : null}
      >
        {loading ? <SkeletonRows count={3} /> : null}
        {users.map((user) => (
          <article className="flex flex-wrap items-center justify-between gap-3 px-4 py-3" key={user.id}>
            <div className="min-w-0">
              <h3 className="text-sm text-neutral-100">{user.name || user.email}</h3>
              <p className="text-[11px] text-neutral-500">{user.email} · {orgRoleLabel(user.role)} · {user.unit_name || "Whole organization"}</p>
            </div>
            {ctx.canManage ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-red-500/20 px-2 py-1 text-[10px] text-red-400/80 hover:border-ops-red hover:text-ops-red"
                onClick={() => {
                  if (window.confirm(`Remove ${user.email}?`)) removeMutation.mutate(user.id);
                }}
              >
                <Trash2 size={11} /> Remove
              </button>
            ) : null}
          </article>
        ))}
        {!loading && !users.length ? <Empty>No people yet.</Empty> : null}
        {removeMutation.error ? <p className="px-4 py-2 text-[11px] text-ops-red">{removeMutation.error.message}</p> : null}
      </List>
    </section>
  );
}

// Audit actions are stored as dotted codes; this turns the common ones into
// words and leaves the rest readable.
function describeAction(action) {
  return String(action || "")
    .replace(/^organization\./, "")
    .replace(/^radio\./, "radio ")
    .replace(/[._]/g, " ");
}

export function ActivityTab({ audit, loading }) {
  return (
    <List title={loading ? "Loading activity…" : `${plural(audit.length, "event")} · newest first`}>
      {loading ? <SkeletonRows count={5} /> : null}
      {audit.map((entry) => (
        <article className="flex flex-wrap items-baseline justify-between gap-3 px-4 py-3" key={entry.id}>
          <div className="min-w-0">
            <h3 className="text-[12px] capitalize text-neutral-100">{describeAction(entry.action)}</h3>
            <p className="text-[11px] text-neutral-500">{entry.actor_name || entry.actor_email || "System"}</p>
          </div>
          <span className="shrink-0 text-[11px] text-neutral-500">{formatDateTime(entry.created_at)}</span>
        </article>
      ))}
      {!loading && !audit.length ? <Empty>Nothing has happened here yet.</Empty> : null}
    </List>
  );
}
