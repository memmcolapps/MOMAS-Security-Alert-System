import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LogIn, Shield } from "lucide-react";
import { useState } from "react";
import { login, setActiveOrganizationId, setAuthToken } from "../lib/api";

export function LoginRoute() {
  const navigate = useNavigate();
  const [form, setForm] = useState({ email: "", password: "" });

  const loginMutation = useMutation({
    mutationFn: login,
    onSuccess: ({ token, user }) => {
      setAuthToken(token);
      setActiveOrganizationId(user.platform_role === "admin" ? null : user.memberships?.[0]?.organization_id || null);
      const orgRole = user.active_membership?.role || user.memberships?.[0]?.role;
      navigate({ to: user.must_change_password ? "/change-password" : user.platform_role === "admin" ? "/admin/organizations" : ["org_owner", "org_admin", "unit_admin", "admin"].includes(orgRole) ? "/org/admin" : "/" });
    },
  });

  return (
    <main className="flex min-h-screen items-center justify-center bg-ops-bg p-6 text-neutral-200">
      <form
        className="glass-panel w-full max-w-sm rounded-lg p-6"
        onSubmit={(event) => {
          event.preventDefault();
          loginMutation.mutate(form);
        }}
      >
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-md border border-ops-line bg-red-500/10 text-ops-red">
            <Shield size={20} />
          </div>
          <div>
            <h1 className="text-base font-bold text-ops-red">EPAIL Intelligence</h1>
            <p className="text-[11px] text-neutral-500">Sign in to your EPAIL or company workspace</p>
          </div>
        </div>
        <label className="mb-3 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Email</span>
          <input className="field-input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
        </label>
        <label className="mb-4 flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-wide text-neutral-500">Password</span>
          <input className="field-input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </label>
        {loginMutation.error ? <p className="mb-3 text-xs text-ops-red">{loginMutation.error.message}</p> : null}
        <button className="inline-flex w-full items-center justify-center gap-2 rounded bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={loginMutation.isPending}>
          <LogIn size={14} /> {loginMutation.isPending ? "Signing in..." : "Sign in"}
        </button>
      </form>
    </main>
  );
}
