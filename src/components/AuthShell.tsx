"use client";

import { UserButton } from "@clerk/nextjs";

export function AuthShell() {
  return (
    <UserButton
      appearance={{
        elements: {
          avatarBox: "h-7 w-7",
          userButtonPopoverCard: "bg-[#0c1024] border border-[rgba(148,163,184,0.08)]",
          userButtonPopoverActionButton: "text-[#94a3b8] hover:text-white",
        },
      }}
    />
  );
}
