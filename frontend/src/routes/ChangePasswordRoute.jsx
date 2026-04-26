import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { KeyRound, Save } from "lucide-react";
import { useState } from "react";
import { changePassword } from "../lib/api";

export function ChangePasswordRoute() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ current_password: "", new_password: "", confirm_password: "" });
  const [error, setError] = useState("");

  const mutation = useMutation({
    mutationFn: changePassword,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      navigate({ to: "/" });
    },
    onError: (nextError) => setError(nextError.message),
  });

  function submit(event) {
    event.preventDefault();
    setError("");
    if (form.new_password !== form.confirm_password) {
      setError("New password and confirmation do not match.");
      return;
    }
    mutation.mutate({
      current_password: form.current_password,
      new_password: form.new_password,
    });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-ops-bg p-6 text-neutral-200">
      <form className="glass-panel w-full max-w-sm rounded-lg p-6" onSubmit={submit}>
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-ops-line bg-red-500/10 text-ops-red">
            <KeyRound size={20} />
          </div>
          <div>
            <h1 className="text-base font-bold text-ops-red">Change password</h1>
            <p className="text-[11px] text-neutral-500">Set a new password before using the console.</p>
          </div>
        </div>

        <Field label="Temporary password">
          <input
            className="field-input"
            type="password"
            value={form.current_password}
            onChange={(event) => setForm({ ...form, current_password: event.target.value })}
          />
        </Field>
        <Field label="New password">
          <input
            className="field-input"
            type="password"
            value={form.new_password}
            onChange={(event) => setForm({ ...form, new_password: event.target.value })}
          />
        </Field>
        <Field label="Confirm new password">
          <input
            className="field-input"
            type="password"
            value={form.confirm_password}
            onChange={(event) => setForm({ ...form, confirm_password: event.target.value })}
          />
        </Field>

        {error ? <p className="mb-3 text-xs text-ops-red">{error}</p> : null}
        <button className="inline-flex w-full items-center justify-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={mutation.isPending}>
          <Save size={14} /> {mutation.isPending ? "Saving..." : "Save new password"}
        </button>
      </form>
    </main>
  );
}

function Field({ label, children }) {
  return (
    <label className="mb-3 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
