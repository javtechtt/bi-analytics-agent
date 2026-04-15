"use client";

import { useState, useRef, useEffect } from "react";
import { useUser, useClerk } from "@clerk/nextjs";
import {
  User,
  ChevronDown,
  Briefcase,
  BarChart3,
  TrendingUp,
  Settings2,
  Globe,
  LogOut,
  Check,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { OutputMode } from "@/lib/types";

interface ProfileMenuProps {
  mode: OutputMode;
  onModeChange: (mode: OutputMode) => void;
  modeDisabled?: boolean;
}

const AGENT_MODES: Array<{ value: OutputMode; label: string; desc: string; icon: typeof Briefcase }> = [
  { value: "executive", label: "Executive", desc: "C-suite, bottom line", icon: Briefcase },
  { value: "analyst", label: "Analyst", desc: "Depth, precision", icon: BarChart3 },
  { value: "sales", label: "Sales", desc: "Revenue, pipeline", icon: TrendingUp },
  { value: "operations", label: "Operations", desc: "Efficiency, risk", icon: Settings2 },
];

const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Espanol" },
  { code: "fr", label: "Francais" },
  { code: "de", label: "Deutsch" },
  { code: "pt", label: "Portugues" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ar", label: "Arabic" },
];

export function ProfileMenu({ mode, onModeChange, modeDisabled }: ProfileMenuProps) {
  const [open, setOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const [language, setLanguage] = useState("en");
  const menuRef = useRef<HTMLDivElement>(null);
  const { user } = useUser();
  const { signOut } = useClerk();

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        setLangOpen(false);
      }
    }
    if (open) document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") { setOpen(false); setLangOpen(false); }
    }
    if (open) document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [open]);

  const displayName = user?.fullName ?? user?.firstName ?? "User";
  const email = user?.primaryEmailAddress?.emailAddress;
  const avatarUrl = user?.imageUrl;
  const currentMode = AGENT_MODES.find((m) => m.value === mode)!;
  const currentLang = LANGUAGES.find((l) => l.code === language)!;

  return (
    <div ref={menuRef} className="relative">
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => { setOpen((v) => !v); setLangOpen(false); }}
        className={cn(
          "flex items-center gap-2.5 rounded-xl border px-3 py-2 transition-all duration-200",
          open
            ? "border-accent-cyan/30 bg-bg-elevated/80 shadow-[0_0_12px_var(--glow-cyan)]"
            : "border-border-subtle bg-bg-elevated/40 hover:border-border-accent hover:bg-bg-elevated/60"
        )}
      >
        {avatarUrl ? (
          <img src={avatarUrl} alt="" className="h-6 w-6 rounded-full ring-1 ring-border-subtle" />
        ) : (
          <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-cyan/15">
            <User className="h-3.5 w-3.5 text-accent-cyan" />
          </div>
        )}
        <div className="hidden items-center gap-1.5 sm:flex">
          <span className="text-xs font-medium text-text-primary">{displayName}</span>
          <div className="flex items-center gap-1 rounded-md bg-accent-cyan/10 px-1.5 py-0.5">
            <currentMode.icon className="h-2.5 w-2.5 text-accent-cyan" />
            <span className="text-[10px] font-medium text-accent-cyan">{currentMode.label}</span>
          </div>
        </div>
        <ChevronDown className={cn(
          "h-3 w-3 text-text-muted transition-transform duration-200",
          open && "rotate-180"
        )} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-72 overflow-hidden rounded-2xl border border-border-subtle bg-bg-surface/95 shadow-[0_8px_40px_rgba(0,0,0,0.5),0_0_60px_var(--glow-cyan)] backdrop-blur-xl">

          {/* User identity */}
          <div className="border-b border-border-subtle px-4 py-3.5">
            <div className="flex items-center gap-3">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" className="h-9 w-9 rounded-full ring-1 ring-border-accent" />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-cyan/15">
                  <User className="h-4.5 w-4.5 text-accent-cyan" />
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{displayName}</p>
                {email && <p className="truncate text-[11px] text-text-muted">{email}</p>}
              </div>
            </div>
          </div>

          {/* Agent type selector */}
          <div className="border-b border-border-subtle px-2 py-2">
            <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.15em] text-text-muted">
              Agent Mode
            </p>
            {AGENT_MODES.map(({ value, label, desc, icon: Icon }) => (
              <button
                key={value}
                type="button"
                disabled={modeDisabled}
                onClick={() => { onModeChange(value); }}
                className={cn(
                  "flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-all duration-150",
                  mode === value
                    ? "bg-accent-cyan/10"
                    : "hover:bg-bg-elevated/60",
                  modeDisabled && "opacity-40 cursor-not-allowed"
                )}
              >
                <div className={cn(
                  "flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-colors",
                  mode === value
                    ? "bg-accent-cyan/20 text-accent-cyan"
                    : "bg-bg-elevated text-text-muted"
                )}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className={cn(
                    "text-xs font-medium",
                    mode === value ? "text-accent-cyan" : "text-text-primary"
                  )}>{label}</p>
                  <p className="text-[10px] text-text-muted">{desc}</p>
                </div>
                {mode === value && (
                  <Check className="h-3.5 w-3.5 shrink-0 text-accent-cyan" />
                )}
              </button>
            ))}
          </div>

          {/* Language */}
          <div className="border-b border-border-subtle px-2 py-2">
            <button
              type="button"
              onClick={() => setLangOpen((v) => !v)}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-all hover:bg-bg-elevated/60"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-text-muted">
                <Globe className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-text-primary">Language</p>
                <p className="text-[10px] text-text-muted">{currentLang.label}</p>
              </div>
              <ChevronDown className={cn(
                "h-3 w-3 text-text-muted transition-transform duration-200",
                langOpen && "rotate-180"
              )} />
            </button>

            {langOpen && (
              <div className="mt-1 grid grid-cols-2 gap-0.5 px-1 pb-1">
                {LANGUAGES.map((lang) => (
                  <button
                    key={lang.code}
                    type="button"
                    onClick={() => { setLanguage(lang.code); setLangOpen(false); }}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-2 py-1.5 text-[11px] transition-colors",
                      language === lang.code
                        ? "bg-accent-cyan/10 text-accent-cyan font-medium"
                        : "text-text-secondary hover:bg-bg-elevated/60 hover:text-text-primary"
                    )}
                  >
                    {language === lang.code && <Check className="h-2.5 w-2.5" />}
                    {lang.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sign out */}
          <div className="px-2 py-2">
            <button
              type="button"
              onClick={() => signOut({ redirectUrl: "/sign-in" })}
              className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-all hover:bg-red-950/30"
            >
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-bg-elevated text-text-muted">
                <LogOut className="h-3.5 w-3.5" />
              </div>
              <p className="text-xs font-medium text-red-400">Sign out</p>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
