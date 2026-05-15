"use client";

/**
 * Entity card fragment — grid of identified parties (people / orgs /
 * accounts) with their roles. Used heavily for contracts, reports with
 * named stakeholders, and any document with a "who is involved" question.
 */

import type { EntityCardProps } from "@/lib/visual/scene-types";
import { Building2, User, Briefcase, Package, MapPin } from "lucide-react";

const ICON_BY_TYPE: Record<string, React.ComponentType<{ className?: string }>> = {
  person: User,
  org: Building2,
  account: Briefcase,
  product: Package,
  location: MapPin,
};

export function EntityCardFragment({ props }: { props: EntityCardProps }) {
  return (
    <div className="glass rounded-2xl p-5">
      <h3 className="text-sm font-semibold text-text-primary">{props.title}</h3>

      <div className="mt-3 grid grid-cols-1 gap-2 md:grid-cols-2">
        {props.entities.map((e, i) => {
          const Icon = ICON_BY_TYPE[e.type] ?? Building2;
          return (
            <div
              key={i}
              className="flex items-start gap-3 rounded-xl border border-border-default/40 bg-bg-elevated/40 p-3"
            >
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent-cyan/10 text-accent-cyan">
                <Icon className="h-4 w-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text-primary">{e.name}</p>
                {e.role && (
                  <p className="text-[11px] uppercase tracking-wider text-accent-cyan/70">{e.role}</p>
                )}
                {e.aliases && e.aliases.length > 0 && (
                  <p className="mt-0.5 truncate text-[11px] text-text-muted">
                    a.k.a. {e.aliases.slice(0, 3).join(", ")}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
