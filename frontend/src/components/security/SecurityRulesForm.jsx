import { useEffect, useState } from "react";

// The sign-in rules, as an organization or the platform sets them. For an
// organization, `ceiling` is the platform's rules: each field says when the
// platform's is stricter, since that is the one in force.

const PHONE_OPTIONS = [
  ["everyone", "Everyone"],
  ["chosen", "Only people allowed on the People tab"],
  ["nobody", "Nobody"],
];
const PHONE_ORDER = ["nobody", "chosen", "everyone"];

const NUMBER_FIELDS = [
  {
    key: "phone_lock_minutes",
    label: "Lock phones after (minutes unused)",
    hint: "Asks for the app PIN. Blank: never. 1 to 1440.",
  },
  {
    key: "phone_idle_minutes",
    label: "Sign phones out after (minutes unused)",
    hint: "Blank: never. 5 to 1440.",
  },
  {
    key: "phone_max_hours",
    label: "Sign phones out after (hours signed in)",
    hint: "Even while in use. Blank: never. 1 to 168.",
  },
];

const toForm = (policy = {}) => ({
  phone_sign_in: policy.phone_sign_in || "everyone",
  phone_lock_minutes: policy.phone_lock_minutes ?? "",
  phone_idle_minutes: policy.phone_idle_minutes ?? "",
  phone_max_hours: policy.phone_max_hours ?? "",
  device_approval: Boolean(policy.device_approval),
  unusual_location_alerts: Boolean(policy.unusual_location_alerts),
});

export function SecurityRulesForm({ policy, ceiling = null, canEdit, onSave, saving, error, saved }) {
  const [form, setForm] = useState(() => toForm(policy));
  useEffect(() => setForm(toForm(policy)), [policy]);
  const set = (patch) => setForm((current) => ({ ...current, ...patch }));

  const phoneCapped = ceiling && PHONE_ORDER.indexOf(ceiling.phone_sign_in) < PHONE_ORDER.indexOf(form.phone_sign_in);
  const limitNote = (key) => {
    const platform = ceiling?.[key];
    if (platform === null || platform === undefined) return null;
    const own = form[key] === "" ? null : Number(form[key]);
    return own === null || platform < own ? `The platform's limit applies: ${platform}.` : null;
  };

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({
          ...form,
          phone_lock_minutes: form.phone_lock_minutes === "" ? null : Number(form.phone_lock_minutes),
          phone_idle_minutes: form.phone_idle_minutes === "" ? null : Number(form.phone_idle_minutes),
          phone_max_hours: form.phone_max_hours === "" ? null : Number(form.phone_max_hours),
        });
      }}
    >
      <fieldset disabled={!canEdit} className="grid gap-4 md:grid-cols-2">
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Who may sign in on a phone</span>
          <select className="field-input" value={form.phone_sign_in} onChange={(event) => set({ phone_sign_in: event.target.value })}>
            {PHONE_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          {phoneCapped ? (
            <span className="text-[10px] text-amber-300">
              The platform allows {ceiling.phone_sign_in === "nobody" ? "nobody" : "only chosen people"} on phones, so that applies.
            </span>
          ) : null}
        </label>
        {NUMBER_FIELDS.map((field) => (
          <label key={field.key} className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-neutral-500">{field.label}</span>
            <input
              className="field-input"
              inputMode="numeric"
              placeholder="Never"
              value={form[field.key]}
              onChange={(event) => set({ [field.key]: event.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
            <span className={`text-[10px] ${limitNote(field.key) ? "text-amber-300" : "text-neutral-600"}`}>
              {limitNote(field.key) || field.hint}
            </span>
          </label>
        ))}
        <Toggle
          checked={form.device_approval}
          onChange={(device_approval) => set({ device_approval })}
          label="New devices need approval"
          hint="A phone or computer signing in for the first time waits until an admin approves it. Devices already in use stay approved."
          forced={ceiling?.device_approval}
        />
        <Toggle
          checked={form.unusual_location_alerts}
          onChange={(unusual_location_alerts) => set({ unusual_location_alerts })}
          label="Alarm on sign-in from an unusual place"
          hint="Amber alarm when someone signs in more than 50 km from anywhere they have before. Needs the device to share its location."
          forced={ceiling?.unusual_location_alerts}
        />
      </fieldset>
      {canEdit ? (
        <div className="flex items-center gap-3">
          <button className="rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black transition hover:opacity-85 active:scale-[0.98] disabled:opacity-50" disabled={saving}>
            {saving ? "Saving…" : "Save rules"}
          </button>
          {saved ? <span className="text-[11px] text-emerald-300">Saved.</span> : null}
          {error ? <span className="text-[11px] text-ops-red">{error}</span> : null}
        </div>
      ) : (
        <p className="text-[11px] text-neutral-500">Only the organization's owner or admins can change these rules.</p>
      )}
    </form>
  );
}

function Toggle({ checked, onChange, label, hint, forced }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-white/10 bg-white/[0.02] p-3">
      <input type="checkbox" className="mt-0.5 accent-ops-red" checked={checked || Boolean(forced)} onChange={(event) => onChange(event.target.checked)} />
      <span>
        <span className="block text-[12px] font-bold text-neutral-100">{label}</span>
        <span className="block text-[11px] text-neutral-500">{forced ? "Turned on by the platform for everyone." : hint}</span>
      </span>
    </label>
  );
}
