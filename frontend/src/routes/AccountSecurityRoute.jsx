import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldAlert, Smartphone } from "lucide-react";
import { useState } from "react";
import { DeviceRows, SessionRows, SmallButton } from "../components/security/DeviceLists";
import { endMySession, getMe, getMySessions, reportDeviceLost, setAppPin, setPanicSecrets } from "../lib/api";

// A person's own sign-in security: where they are signed in, a "lost phone"
// button, their app PIN, and their panic password and PIN.
export function AccountSecurityRoute() {
  const queryClient = useQueryClient();
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const sessionsQuery = useQuery({ queryKey: ["my-sessions"], queryFn: getMySessions, refetchInterval: 30_000 });
  const user = meQuery.data?.user;
  const sessions = sessionsQuery.data?.sessions || [];
  const devices = sessionsQuery.data?.devices || [];
  const currentDeviceId = sessions.find((session) => session.current)?.device_id;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["my-sessions"] });

  // Signing a device out shows at once; the list is fetched again to confirm.
  const endMutation = useMutation({
    mutationFn: endMySession,
    onMutate: async (sessionId) => {
      await queryClient.cancelQueries({ queryKey: ["my-sessions"] });
      const before = queryClient.getQueryData(["my-sessions"]);
      queryClient.setQueryData(["my-sessions"], (data) =>
        data ? { ...data, sessions: data.sessions.filter((session) => session.id !== sessionId) } : data);
      return { before };
    },
    onError: (_error, _id, context) => queryClient.setQueryData(["my-sessions"], context?.before),
    onSettled: refresh,
  });
  const lostMutation = useMutation({ mutationFn: reportDeviceLost, onSettled: refresh });
  const others = sessions.filter((session) => !session.current);

  return (
    <main className="device-page bg-ops-bg px-4 pb-10 pt-[calc(var(--ops-chrome)+1.5rem)] text-neutral-200 md:px-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <header>
          <h1 className="text-xl font-bold text-neutral-100">My devices & PIN</h1>
          <p className="mt-1 text-[12px] text-neutral-500">Where you are signed in, and what protects your account if a phone is lost or taken.</p>
        </header>

        <Card
          icon={Smartphone}
          title="Signed in now"
          action={others.length ? (
            <SmallButton
              danger
              disabled={endMutation.isPending}
              onClick={() => others.forEach((session) => endMutation.mutate(session.id))}
            >
              Sign out all others
            </SmallButton>
          ) : null}
        >
          {sessionsQuery.isLoading ? <Skeleton /> : (
            <SessionRows
              sessions={sessions}
              actions={(session) => session.current ? null : (
                <SmallButton danger onClick={() => endMutation.mutate(session.id)}>Sign out</SmallButton>
              )}
            />
          )}
          {endMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{endMutation.error.message}</p> : null}
        </Card>

        <Card icon={ShieldAlert} title="Lost or stolen device">
          <p className="mb-2 text-[12px] text-neutral-400">
            Reporting a device lost signs it out, blocks it from signing in again, and tells your control room.
          </p>
          {sessionsQuery.isLoading ? <Skeleton /> : (
            <DeviceRows
              devices={devices}
              actions={(device) => device.status === "blocked" || device.id === currentDeviceId ? null : (
                <SmallButton
                  danger
                  disabled={lostMutation.isPending}
                  onClick={() => {
                    if (window.confirm(`Report "${device.label}" lost? It will be signed out and blocked.`)) lostMutation.mutate(device.id);
                  }}
                >
                  Report lost
                </SmallButton>
              )}
            />
          )}
          {lostMutation.isSuccess ? <p className="mt-2 text-[11px] text-emerald-300">Reported. The device is signed out and blocked.</p> : null}
          {lostMutation.error ? <p className="mt-2 text-[11px] text-ops-red">{lostMutation.error.message}</p> : null}
        </Card>

        <PinCard hasPin={user?.has_app_pin} />
        <PanicCard user={user} />
      </div>
    </main>
  );
}

function Card({ icon: Icon, title, action, children }) {
  return (
    <section className="glass-panel rounded-lg p-4 md:p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-bold text-neutral-100">
          <Icon size={15} className="text-ops-red" /> {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 py-1">
      {[0, 1].map((row) => <div key={row} className="h-10 animate-pulse rounded bg-white/[0.05]" />)}
    </div>
  );
}

function SecretField({ label, value, onChange, numeric, hint }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      <input
        className="field-input"
        type="password"
        autoComplete="new-password"
        inputMode={numeric ? "numeric" : undefined}
        value={value}
        onChange={(event) => onChange(numeric ? event.target.value.replace(/\D/g, "").slice(0, 8) : event.target.value)}
      />
      {hint ? <span className="text-[10px] text-neutral-600">{hint}</span> : null}
    </label>
  );
}

function PinCard({ hasPin }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ password: "", pin: "" });
  const mutation = useMutation({
    mutationFn: () => setAppPin(form),
    onSuccess: () => {
      setForm({ password: "", pin: "" });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  return (
    <Card icon={KeyRound} title="App PIN">
      <p className="mb-3 text-[12px] text-neutral-400">
        {hasPin ? "Set. " : "Not set. "}
        Unlocks EPAIL on a phone after it has been unused for a while, if your organization turns that on.
      </p>
      <form
        className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          mutation.mutate();
        }}
      >
        <SecretField label="Your password" value={form.password} onChange={(password) => setForm({ ...form, password })} />
        <SecretField label={hasPin ? "New PIN" : "PIN"} numeric value={form.pin} onChange={(pin) => setForm({ ...form, pin })} />
        <button className="rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50" disabled={mutation.isPending || !form.password || form.pin.length < 4}>
          {mutation.isPending ? "Saving…" : hasPin ? "Change PIN" : "Set PIN"}
        </button>
      </form>
      {mutation.isSuccess ? <p className="mt-2 text-[11px] text-emerald-300">PIN saved.</p> : null}
      {mutation.error ? <p className="mt-2 text-[11px] text-ops-red">{mutation.error.message}</p> : null}
    </Card>
  );
}

function PanicCard({ user }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ password: "", panic_password: "", panic_pin: "" });
  const mutation = useMutation({
    mutationFn: (payload) => setPanicSecrets(payload),
    onSuccess: () => {
      setForm({ password: "", panic_password: "", panic_pin: "" });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
  });
  const save = () => mutation.mutate({
    password: form.password,
    ...(form.panic_password ? { panic_password: form.panic_password } : {}),
    ...(form.panic_pin ? { panic_pin: form.panic_pin } : {}),
  });
  const clear = () => {
    if (!form.password) return;
    mutation.mutate({ password: form.password, panic_password: null, panic_pin: null });
  };
  const status = (set) => (set ? <span className="text-emerald-300">set</span> : <span className="text-neutral-500">not set</span>);

  return (
    <Card icon={ShieldAlert} title="Panic password and PIN">
      <div className="mb-3 space-y-1.5 text-[12px] text-neutral-400">
        <p>
          If you are ever forced to sign in or unlock EPAIL, use these instead of your real ones. EPAIL opens as normal,
          shows nothing of your organization, signs your other devices out, and silently raises a red alarm with your location.
        </p>
        <p>
          Make them easy to remember under stress, like your password with a few digits added. Until an admin closes the
          alarm, your real password will not work.
        </p>
        <p>Panic password: {status(user?.has_panic_password)} · Panic PIN: {status(user?.has_panic_pin)}</p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-3"
        onSubmit={(event) => {
          event.preventDefault();
          save();
        }}
      >
        <SecretField label="Your password" value={form.password} onChange={(password) => setForm({ ...form, password })} />
        <SecretField
          label="Panic password"
          value={form.panic_password}
          onChange={(panic_password) => setForm({ ...form, panic_password })}
          hint="At least 8 characters, different from your password"
        />
        <SecretField
          label="Panic PIN"
          numeric
          value={form.panic_pin}
          onChange={(panic_pin) => setForm({ ...form, panic_pin })}
          hint="4 to 8 digits, for the lock screen"
        />
        <div className="flex flex-wrap gap-2 sm:col-span-3">
          <button
            className="rounded-md bg-ops-red px-4 py-2 text-xs font-bold text-black disabled:opacity-50"
            disabled={mutation.isPending || !form.password || (!form.panic_password && !form.panic_pin)}
          >
            {mutation.isPending ? "Saving…" : "Save"}
          </button>
          {user?.has_panic_password || user?.has_panic_pin ? (
            <SmallButton danger disabled={!form.password || mutation.isPending} onClick={clear}>Remove both</SmallButton>
          ) : null}
        </div>
      </form>
      {mutation.isSuccess ? <p className="mt-2 text-[11px] text-emerald-300">Saved.</p> : null}
      {mutation.error ? <p className="mt-2 text-[11px] text-ops-red">{mutation.error.message}</p> : null}
    </Card>
  );
}
