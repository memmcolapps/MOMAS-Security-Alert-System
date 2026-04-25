import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, ChevronDown, LogOut, Map, Radio, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getMe, setAuthToken } from "../lib/api";

export function AppHeader() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const router = useRouterState();
  const path = router.location.pathname;

  const meQuery = useQuery({ queryKey: ["me"], queryFn: getMe, staleTime: 60_000 });
  const user = meQuery.data?.user;
  const isAdmin = user?.platform_role === "admin";

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const onClick = (event) => {
      if (!menuRef.current?.contains(event.target)) setMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  const isActive = (prefix) => path === prefix || path.startsWith(`${prefix}/`);

  function logout() {
    setAuthToken(null);
    queryClient.clear();
    navigate({ to: "/login" });
  }

  return (
    <header className="fixed left-0 right-0 top-0 z-[1100] border-b border-white/10 bg-black/70 backdrop-blur">
      <div className="flex h-12 items-center gap-4 px-4 text-neutral-200">
        <Link to="/" className="flex items-center gap-2 text-[12px] font-bold tracking-wide text-ops-red">
          <ShieldAlert size={16} /> EPAIL
        </Link>

        <nav className="flex items-center gap-1 text-[11px] font-bold">
          <NavItem to="/" icon={Map} label="Map" active={path === "/"} />
          <NavItem to="/devices" icon={Radio} label="Devices" active={isActive("/devices")} />
          {isAdmin ? (
            <NavItem to="/admin/organizations" icon={Building2} label="Companies" active={isActive("/admin/organizations")} />
          ) : null}
        </nav>

        <div className="ml-auto" ref={menuRef}>
          {user ? (
            <button
              onClick={() => setMenuOpen((value) => !value)}
              className="inline-flex items-center gap-2 rounded border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px] hover:bg-white/[0.07]"
            >
              <span className="grid h-5 w-5 place-items-center rounded-full bg-ops-red text-[10px] font-bold text-black">
                {(user.name || user.email || "?").trim()[0]?.toUpperCase()}
              </span>
              <span className="hidden max-w-[180px] truncate text-neutral-300 sm:inline">{user.email}</span>
              <ChevronDown size={12} className="text-neutral-500" />
            </button>
          ) : null}

          {menuOpen ? (
            <div className="absolute right-4 mt-2 w-56 rounded-md border border-white/10 bg-black/95 p-2 shadow-xl backdrop-blur">
              <div className="border-b border-white/10 px-2 pb-2 text-[11px] text-neutral-400">
                <div className="truncate font-bold text-neutral-200">{user?.name || user?.email}</div>
                <div className="truncate text-neutral-500">
                  {isAdmin ? "Platform admin" : user?.email && user.email !== user?.name ? user.email : "Org user"}
                </div>
              </div>
              <button
                className="mt-1 inline-flex w-full items-center gap-2 rounded px-2 py-1.5 text-[11px] text-neutral-300 hover:bg-white/10"
                onClick={logout}
              >
                <LogOut size={13} /> Sign out
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

function NavItem({ to, icon: Icon, label, active }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 transition ${
        active ? "bg-white/10 text-ops-red" : "text-neutral-400 hover:bg-white/5 hover:text-neutral-100"
      }`}
    >
      <Icon size={13} /> {label}
    </Link>
  );
}
