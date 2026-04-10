"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import type { Message } from "@/lib/types";

interface TranscriptOverlayProps {
  messages: Message[];
}

export function TranscriptOverlay({ messages }: TranscriptOverlayProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) return null;

  // Show only the last few messages to keep it unobtrusive
  const visible = messages.slice(-6);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center pb-8">
      {/* Fade-out gradient at top of transcript area */}
      <div className="relative w-full max-w-2xl">
        <div className="absolute -top-8 left-0 right-0 h-8 bg-gradient-to-b from-transparent to-transparent" />

        <div className="flex max-h-48 flex-col gap-2 overflow-y-auto px-6 scrollbar-none">
          {visible.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "rounded-xl px-4 py-2 text-sm leading-relaxed backdrop-blur-sm transition-opacity duration-300",
                msg.role === "user"
                  ? "self-end bg-white/5 text-text-secondary"
                  : "self-start bg-white/[0.03] text-text-primary",
                msg.streaming && "animate-pulse",
                // Hide empty placeholder messages
                !msg.content && "opacity-0"
              )}
            >
              {msg.role === "assistant" && msg.content && (
                <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-[0.2em] text-accent-indigo/70">
                  Analyst
                </span>
              )}
              {msg.content || "\u00A0"}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
