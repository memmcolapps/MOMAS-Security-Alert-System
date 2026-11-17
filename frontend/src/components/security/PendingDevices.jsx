import { Laptop, Smartphone } from "lucide-react";
import { relativeAge } from "../org/shared";
import { SmallButton } from "./DeviceLists";

// Devices waiting for an admin, newest first. Approving lets the person sign
// in on it; blocking stops it for good.
export function PendingDevices({ devices, onDecide, busy }) {
  if (!devices.length) {
    return <p className="py-2 text-[12px] text-neutral-500">Nothing waiting. New devices show here when approval is on.</p>;
  }
  return (
    <ul className="divide-y divide-white/5">
      {devices.map((device) => {
        const Icon = device.is_phone ? Smartphone : Laptop;
        return (
          <li key={device.id} className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-amber-400/30 bg-amber-400/10 text-amber-300">
              <Icon size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[12px] text-neutral-100">{device.user_name || device.user_email} · {device.label}</p>
              <p className="text-[11px] text-neutral-500">{device.user_email} · asked {relativeAge(device.last_seen_at) || "just now"}</p>
            </div>
            <div className="flex gap-1.5">
              <SmallButton primary disabled={busy} onClick={() => onDecide(device, "approve")}>Approve</SmallButton>
              <SmallButton danger disabled={busy} onClick={() => onDecide(device, "block")}>Block</SmallButton>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
