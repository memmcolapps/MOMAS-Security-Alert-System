import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Delete, KeyRound, Lock, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getMe, onSessionEvent, setAppPin, signOut, unlockApp } from "../lib/api";
import { noteInputNow } from "../lib/device";

// On a phone under its organization's rules, the console locks after a few
// minutes unused and asks for the app PIN, and asks for a PIN to be set if
// there is none. The server enforces both - nothing reaches a locked session -
// and this covers the screen so nothing already on it stays readable.
//
// While the console is hidden (another app, the app switcher, screen off) it
// is covered at once, and locked when it comes back if it was away long enough.

export function AppLock({ enabled }) {
  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000, enabled });
  const user = meQuery.data?.user;
  const lockMinutes = user?.session_rules?.phone ? Number(user.session_rules.lock_minutes) || 0 : 0;
  const [locked, setLocked] = useState(false);
  const [covered, setCovered] = useState(false);
  const [pinNeeded, setPinNeeded] = useState(false);
  const hiddenAt = useRef(null);

  useEffect(() => {
    if (!enabled) return undefined;
    return onSessionEvent((type) => {
      if (type === "locked") setLocked(true);
      if (type === "pin_required") setPinNeeded(true);
    });
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !lockMinutes) return undefined;
    const onVisibility = () => {
      if (window.document.visibilityState === "hidden") {
        hiddenAt.current = Date.now();
        setCovered(true);
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (away >= lockMinutes * 60_000) setLocked(true);
      setCovered(false);
    };
    window.document.addEventListener("visibilitychange", onVisibility);
    return () => window.document.removeEventListener("visibilitychange", onVisibility);
  }, [enabled, lockMinutes]);

  if (!enabled) return null;
  if (pinNeeded || user?.pin_required) return <PinSetup />;
  if (locked || user?.app_locked) return <LockScreen />;
  if (covered) return <div className="fixed inset-0 z-[5000] bg-ops-bg" aria-hidden />;
  return null;
}

function Screen({ children }) {
  return (
    <div className="fixed inset-0 z-[5000] flex items-center justify-center bg-ops-bg p-4 text-neutral-200">
      <div className="glass-panel w-full max-w-xs rounded-xl p-6">{children}</div>
    </div>
  );
}

function Title({ icon: Icon, title, text }) {
  return (
    <div className="mb-5 flex flex-col items-center text-center">
      <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full border border-ops-line bg-red-500/10 text-ops-red">
        <Icon size={20} />
      </div>
      <h1 className="text-base font-bold text-neutral-100">{title}</h1>
      <p className="mt-1 text-[12px] text-neutral-500">{text}</p>
    </div>
  );
}

async function leave() {
  await signOut();
  window.location.assign("/login");
}

function LockScreen() {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(value) {
    if (busy || value.length < 4) return;
    setBusy(true);
    setError("");
    try {
      await unlockApp(value);
      noteInputNow();
      // A fresh page, so what shows next comes from the server as it is now.
      window.location.reload();
    } catch (failure) {
      setPin("");
      setError(failure.message);
      setBusy(false);
    }
  }

  const press = (digit) => {
    const next = `${pin}${digit}`.slice(0, 8);
    setPin(next);
    setError("");
  };

  return (
    <Screen>
      <Title icon={Lock} title="EPAIL is locked" text="Enter your app PIN to continue." />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(pin);
        }}
      >
        <input
          autoFocus
          className="field-input mb-3 w-full text-center text-lg tracking-[0.5em]"
          inputMode="numeric"
          autoComplete="off"
          type="password"
          value={pin}
          aria-label="App PIN"
          onChange={(event) => setPin(event.target.value.replace(/\D/g, "").slice(0, 8))}
        />
        <div className="grid grid-cols-3 gap-2">
          {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
            <Key key={digit} onClick={() => press(digit)}>{digit}</Key>
          ))}
          <Key onClick={() => setPin(pin.slice(0, -1))} label="Delete">
            <Delete size={16} />
          </Key>
          <Key onClick={() => press("0")}>0</Key>
          <button
            type="submit"
            disabled={busy || pin.length < 4}
            className="rounded-lg bg-ops-red text-xs font-bold text-black transition active:scale-95 disabled:opacity-40"
          >
            {busy ? "…" : "Unlock"}
          </button>
        </div>
      </form>
      <p className="mt-3 min-h-[1rem] text-center text-[11px] text-ops-red">{error}</p>
      <button type="button" onClick={leave} className="mx-auto mt-1 flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-neutral-200">
        <LogOut size={12} /> Sign out instead
      </button>
    </Screen>
  );
}

function Key({ children, onClick, label }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="flex h-12 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-lg text-neutral-100 transition hover:bg-white/[0.08] active:scale-95"
    >
      {children}
    </button>
  );
}

function PinSetup() {
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ password: "", pin: "", confirm: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    setError("");
    if (!/^\d{4,8}$/.test(form.pin)) return setError("A PIN is 4 to 8 digits.");
    if (form.pin !== form.confirm) return setError("The two PINs do not match.");
    setBusy(true);
    try {
      await setAppPin({ password: form.password, pin: form.pin });
      await queryClient.invalidateQueries({ queryKey: ["me"] });
      window.location.reload();
    } catch (failure) {
      setError(failure.message);
      setBusy(false);
    }
  }

  const field = (key, label, numeric) => (
    <label className="mb-3 flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      <input
        className="field-input"
        type="password"
        inputMode={numeric ? "numeric" : undefined}
        autoComplete={numeric ? "off" : "current-password"}
        value={form[key]}
        onChange={(event) => setForm({ ...form, [key]: numeric ? event.target.value.replace(/\D/g, "").slice(0, 8) : event.target.value })}
      />
    </label>
  );

  return (
    <Screen>
      <Title
        icon={KeyRound}
        title="Set an app PIN"
        text="Your organization locks EPAIL on phones when they are not in use. You will unlock it with this PIN."
      />
      <form onSubmit={submit}>
        {field("password", "Your password")}
        {field("pin", "New PIN (4 to 8 digits)", true)}
        {field("confirm", "Same PIN again", true)}
        {error ? <p className="mb-3 text-xs text-ops-red">{error}</p> : null}
        <button className="w-full rounded-md bg-ops-red px-4 py-2.5 text-xs font-bold text-black disabled:opacity-50" disabled={busy}>
          {busy ? "Saving…" : "Set PIN"}
        </button>
      </form>
      <button type="button" onClick={leave} className="mx-auto mt-3 flex items-center gap-1.5 text-[11px] text-neutral-500 hover:text-neutral-200">
        <LogOut size={12} /> Sign out instead
      </button>
    </Screen>
  );
}
