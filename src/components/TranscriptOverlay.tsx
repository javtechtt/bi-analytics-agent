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

  // Filter out empty placeholder messages before deciding to render
  const visible = messages.filter((m) => m.content.trim()).slice(-6);

  if (visible.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col items-center pb-8">
      <div className="relative w-full max-w-2xl">
        {/* Fade gradient so messages blend into the scene at the top */}
        <div className="absolute -top-10 left-0 right-0 h-10 bg-gradient-to-b from-transparent to-bg-deep/80" />

        <div className="flex max-h-52 flex-col gap-2.5 overflow-y-auto px-6">
          {visible.map((msg) => (
            <div
              key={msg.id}
              className={cn(
                "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed backdrop-blur-md transition-opacity duration-500",
                msg.role === "user"
                  ? "self-end bg-white/10 text-text-primary"
                  : "self-start bg-bg-elevated/70 text-text-primary border border-border-subtle",
                msg.streaming && "opacity-80"
              )}
            >
              {msg.role === "assistant" && (
                <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-widest text-accent-indigo/80">
                  Analyst
                </span>
              )}
              {msg.content}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
