"use client";

import { useState, useRef, useCallback } from "react";
import {
  FileUp,
  X,
  FileText,
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/cn";
import type { UploadedFile } from "@/lib/types";

const ACCEPT = ".csv,.xlsx,.xls,.pdf";

interface DocumentPanelProps {
  files: UploadedFile[];
  onUpload: (files: FileList) => void;
  onRemove: (id: string) => void;
}

export function DocumentPanel({ files, onUpload, onRemove }: DocumentPanelProps) {
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) onUpload(e.dataTransfer.files);
    },
    [onUpload]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const readyCount = files.filter((f) => f.status === "ready").length;

  return (
    <div className="fixed top-3 right-3 z-40 flex flex-col items-end gap-1">
      {/* Toggle button */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "glass flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs font-medium transition-all duration-200",
          "hover:border-border-accent hover:shadow-[0_0_12px_var(--glow-cyan)]",
          open ? "text-accent-cyan" : "text-text-secondary"
        )}
      >
        <FileUp className="h-3.5 w-3.5" />
        <span>Documents</span>
        {files.length > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-accent-cyan/20 px-1 text-[10px] font-bold text-accent-cyan">
            {files.length}
          </span>
        )}
        {open ? (
          <ChevronUp className="h-3 w-3" />
        ) : (
          <ChevronDown className="h-3 w-3" />
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div
          className="glass w-72 rounded-xl p-3"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          {/* Upload zone */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className={cn(
              "flex w-full flex-col items-center gap-2 rounded-lg border border-dashed border-border-accent/50 py-4 transition-colors duration-200",
              "hover:bg-accent-cyan/5 hover:border-accent-cyan/40"
            )}
          >
            <FileUp className="h-5 w-5 text-text-muted" />
            <span className="text-xs text-text-muted">
              CSV, Excel, or PDF
            </span>
          </button>

          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) onUpload(e.target.files);
              e.target.value = "";
            }}
          />

          {/* File list */}
          {files.length > 0 && (
            <>
              {readyCount > 0 && (
                <p className="mt-2 text-[10px] text-accent-cyan/70">
                  {readyCount} file{readyCount > 1 ? "s" : ""} in assistant
                  context
                </p>
              )}

              <div className="mt-2 flex max-h-52 flex-col gap-1.5 overflow-y-auto">
                {files.map((f) => (
                  <div
                    key={f.id}
                    className={cn(
                      "flex items-center gap-2 rounded-lg px-2.5 py-2",
                      f.status === "error"
                        ? "bg-red-500/5"
                        : "bg-bg-elevated/60"
                    )}
                  >
                    {/* Status icon */}
                    {f.status === "parsing" && (
                      <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-accent-cyan/60" />
                    )}
                    {f.status === "ready" && (
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400/70" />
                    )}
                    {f.status === "error" && (
                      <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-400/70" />
                    )}

                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs text-text-primary">
                        {f.name}
                      </p>
                      <p className="text-[10px] text-text-muted">
                        {f.status === "parsing" && (f.progressMessage ?? "Parsing…")}
                        {f.status === "ready" && (f.summary ?? f.sizeLabel)}
                        {f.status === "error" && (
                          <span className="text-red-400">{f.error}</span>
                        )}
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => onRemove(f.id)}
                      className="shrink-0 rounded p-0.5 text-text-muted transition-colors hover:text-red-400"
                      aria-label={`Remove ${f.name}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {files.length === 0 && (
            <p className="mt-3 text-center text-[11px] text-text-muted">
              No documents uploaded yet
            </p>
          )}
        </div>
      )}
    </div>
  );
}
