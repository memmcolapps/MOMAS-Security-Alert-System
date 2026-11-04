import { X } from "lucide-react";
import { useEffect } from "react";

// Pieces shared by every tab of the organization page, so a list, a field or a
// side panel looks and behaves the same wherever it appears.

export function List({ title, action, children }) {
  return (
    <div className="glass-panel overflow-hidden rounded-lg">
      {title || action ? (
        <div className="flex items-center justify-between gap-3 border-b border-white/10 px-4 py-3 text-[11px] text-neutral-500">
          <span>{title}</span>
          {action}
        </div>
      ) : null}
      <div className="divide-y divide-white/5">{children}</div>
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wide text-neutral-500">{label}</span>
      {children}
    </label>
  );
}

export function Empty({ children }) {
  return <div className="px-4 py-10 text-center text-[12px] text-neutral-500">{children}</div>;
}

export function SkeletonRows({ count = 6 }) {
  return (
    <div className="divide-y divide-white/5">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-4 py-3">
          <span className="h-2 w-2 rounded-full bg-white/10" />
          <span className="h-3 w-40 animate-pulse rounded bg-white/[0.07]" />
          <span className="ml-auto h-3 w-16 animate-pulse rounded bg-white/[0.05]" />
        </div>
      ))}
    </div>
  );
}

export function FilterChips({ options, value, onChange }) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          onClick={() => onChange(option.key)}
          className={`rounded-full border px-3 py-1 text-[11px] font-bold transition ${
            value === option.key
              ? "border-ops-red/50 bg-ops-red/15 text-ops-red"
              : "border-white/10 bg-white/[0.03] text-neutral-400 hover:text-neutral-200"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// A side panel that slides over the right of the page, below the app chrome.
// Non-blocking reading, one at a time: opening another replaces it.
export function SidePanel({ title, subtitle, onClose, children }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        type="button"
        aria-label="Close panel"
        className="fixed inset-0 z-[1040] cursor-default bg-black/30"
        onClick={onClose}
      />
      <aside
        className="fixed bottom-0 right-0 z-[1050] flex w-full max-w-[440px] flex-col border-l border-white/10 bg-[#0b0d0c]/95 shadow-2xl backdrop-blur"
        style={{ top: "var(--ops-chrome, 80px)" }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-neutral-100">{title}</h2>
            {subtitle ? <p className="mt-0.5 truncate text-[11px] text-neutral-500">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="shrink-0 rounded p-1 text-neutral-500 hover:bg-white/5 hover:text-neutral-100"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</div>
      </aside>
    </>
  );
}

export function PanelSection({ title, children, action }) {
  return (
    <section className="border-b border-white/5 px-5 py-4">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10px] font-bold uppercase tracking-wide text-neutral-500">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export function unitOptionLabel(unit) {
  return unit.parent_name ? `${unit.parent_name} / ${unit.name}` : unit.name;
}

export function formatDateTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
}

export function relativeAge(value) {
  if (!value) return null;
  const stamp = new Date(value).getTime();
  if (!Number.isFinite(stamp)) return null;
  const seconds = Math.max(0, Math.round((Date.now() - stamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
}

export function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
