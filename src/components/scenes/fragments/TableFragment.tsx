"use client";

/**
 * Table fragment — compact tabular preview. NOT a data-grid replacement:
 * this is for showing a handful of sample rows with their column types,
 * typically as supporting evidence within a larger scene.
 */

import type { TableProps } from "@/lib/visual/scene-types";

export function TableFragment({ props }: { props: TableProps }) {
  const maxRows = props.maxRows ?? 10;
  const rows = props.rows.slice(0, maxRows);

  return (
    <div className="glass rounded-2xl p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-text-primary">{props.title}</h3>
        {props.caption && (
          <span className="text-[10px] uppercase tracking-widest text-text-muted">
            {props.caption}
          </span>
        )}
      </div>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border-default/40">
              {props.columns.map((c) => (
                <th
                  key={c}
                  className="px-2 py-2 text-left font-medium text-text-muted whitespace-nowrap"
                >
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, idx) => (
              <tr key={idx} className="border-b border-border-default/20 last:border-b-0">
                {props.columns.map((c) => (
                  <td
                    key={c}
                    className="px-2 py-1.5 text-text-secondary whitespace-nowrap"
                  >
                    {formatCell(row[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function formatCell(v: string | number | null | undefined): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    if (Math.abs(v) >= 1_000_000) return (v / 1_000_000).toFixed(2) + "M";
    if (Math.abs(v) >= 1000) return (v / 1000).toFixed(1) + "K";
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
  }
  const s = String(v);
  return s.length > 60 ? s.slice(0, 57) + "…" : s;
}
