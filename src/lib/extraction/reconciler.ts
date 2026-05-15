/**
 * Phase 2: Multi-chunk reconciliation.
 *
 * Long documents are extracted in chunks (page groups). Each chunk produces
 * an independent ExtractionResult — the same entity (e.g. "Acme Corp")
 * may be mentioned in multiple chunks, the same metric may be repeated
 * with slight variations, and timeline events arrive in arbitrary order.
 *
 * This module merges chunk results into a single coherent extraction:
 *
 *   - ENTITIES are deduped on canonicalName (case/space-insensitive).
 *     Aliases are unioned across mentions. The first observed role wins
 *     unless a later mention has a more specific one.
 *
 *   - METRICS with the same (name, period) and different values are
 *     surfaced as CONFLICT facts so the agent can flag them rather than
 *     silently picking one.
 *
 *   - FACTS are concatenated — near-duplicates (same type + subject +
 *     value) are dropped to keep the list tight, but we do NOT semantic-
 *     dedupe aggressively in Phase 2; that's an LLM-judge task for later.
 *
 *   - TIMELINE is sorted by date (ISO if available, else lexical fallback).
 */

import type { ExtractionResult, ExtractedEntity } from "./schemas";

export interface ReconciledExtraction extends ExtractionResult {
  /** Conflicts detected during reconciliation — same metric, different values. */
  conflicts: Array<{ name: string; period: string | null; values: string[] }>;
}

export function reconcile(chunks: ExtractionResult[]): ReconciledExtraction {
  if (chunks.length === 0) {
    return { facts: [], entities: [], metrics: [], timeline: [], conflicts: [] };
  }
  if (chunks.length === 1) {
    return { ...chunks[0], conflicts: [] };
  }

  // ── Entities: merge by canonical key ──
  const entityMap = new Map<string, ExtractedEntity>();
  for (const chunk of chunks) {
    for (const e of chunk.entities) {
      const key = canonicalKey(e.canonicalName);
      const existing = entityMap.get(key);
      if (!existing) {
        entityMap.set(key, {
          canonicalName: e.canonicalName,
          type: e.type,
          aliases: [...new Set([e.canonicalName, ...e.aliases])].filter(
            (a) => canonicalKey(a) !== key
          ),
          role: e.role,
        });
      } else {
        // Merge aliases
        const merged = new Set([
          ...existing.aliases,
          e.canonicalName,
          ...e.aliases,
        ]);
        merged.delete(existing.canonicalName);
        existing.aliases = [...merged];
        // Prefer non-null role; if both present and differ, keep first.
        if (!existing.role && e.role) existing.role = e.role;
      }
    }
  }
  const entities = [...entityMap.values()];

  // ── Metrics: detect conflicts on (name, period) ──
  const metricGroups = new Map<string, ExtractionResult["metrics"]>();
  for (const chunk of chunks) {
    for (const m of chunk.metrics) {
      const key = `${m.name.toLowerCase().trim()}|${(m.period ?? "").toLowerCase().trim()}`;
      if (!metricGroups.has(key)) metricGroups.set(key, []);
      metricGroups.get(key)!.push(m);
    }
  }
  const metrics: ExtractionResult["metrics"] = [];
  const conflicts: ReconciledExtraction["conflicts"] = [];
  for (const [, group] of metricGroups) {
    if (group.length === 1) {
      metrics.push(group[0]);
      continue;
    }
    // Multiple values for same metric+period. If all valueText match, dedupe.
    const distinctValues = [...new Set(group.map((m) => m.valueText.trim()))];
    if (distinctValues.length === 1) {
      metrics.push(group[0]);
    } else {
      // Conflict — keep the first one but record the disagreement.
      metrics.push(group[0]);
      conflicts.push({
        name: group[0].name,
        period: group[0].period,
        values: distinctValues,
      });
    }
  }

  // ── Facts: concat, dedupe on (type, subject, value) ──
  const factKey = (f: ExtractionResult["facts"][number]) =>
    `${f.type}|${(f.subject ?? "").toLowerCase().trim()}|${f.value.toLowerCase().trim()}`;
  const factSeen = new Set<string>();
  const facts: ExtractionResult["facts"] = [];
  for (const chunk of chunks) {
    for (const f of chunk.facts) {
      const key = factKey(f);
      if (factSeen.has(key)) continue;
      factSeen.add(key);
      facts.push(f);
    }
  }

  // ── Timeline: concat, sort ──
  const timeline = chunks
    .flatMap((c) => c.timeline)
    .sort((a, b) => {
      const da = parseDateForSort(a.date);
      const db = parseDateForSort(b.date);
      if (da && db) return da - db;
      return a.date.localeCompare(b.date);
    });

  return { facts, entities, metrics, timeline, conflicts };
}

function canonicalKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s\-.,]+/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|company|co)\b\.?/g, "")
    .trim();
}

function parseDateForSort(s: string): number | null {
  // Try ISO first
  const iso = Date.parse(s);
  if (!Number.isNaN(iso)) return iso;
  return null;
}
