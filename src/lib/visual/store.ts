/**
 * Phase 3: Scene store.
 *
 * Minimal persistence helper. Phase 3 keeps scenes primarily in client
 * memory (managed by useRealtimeSession). When a scene is composed
 * server-side (via the compose_visual_scene tool), we OPTIONALLY persist
 * it to the `scenes` table so it can be reloaded in a later session.
 *
 * Persistence is non-blocking: a failure to save logs and continues — the
 * scene is still returned to the client and rendered. Phase 4 may upgrade
 * to a robust save-with-retry path.
 */

import { getSql, toJsonb } from "@/lib/db";
import type { VisualScene } from "./scene-types";

export interface SaveSceneInput {
  scene: VisualScene;
  userId: string;
  sessionId: string | null;
}

export async function saveScene(input: SaveSceneInput): Promise<void> {
  const { scene, userId, sessionId } = input;
  if (!sessionId) {
    // No session → nothing to persist. Scene still lives in client memory.
    return;
  }
  try {
    const sql = getSql();
    await sql`
      insert into scenes (
        id, session_id, document_id, user_id, title, layout, fragments,
        caption, confidence, drilldowns
      ) values (
        ${scene.id}, ${sessionId}, ${scene.documentId ?? null}, ${userId},
        ${scene.title}, ${scene.layout}, ${toJsonb(scene.fragments)}::jsonb,
        ${scene.caption ?? null}, ${confidenceLabelToScore(scene.confidence)},
        ${toJsonb(scene.drilldowns ?? [])}::jsonb
      )
      on conflict (id) do update set
        session_id = excluded.session_id,
        document_id = excluded.document_id,
        user_id = excluded.user_id,
        title = excluded.title,
        layout = excluded.layout,
        fragments = excluded.fragments,
        caption = excluded.caption,
        confidence = excluded.confidence,
        drilldowns = excluded.drilldowns
    `;
  } catch (err) {
    console.warn("[scenes/store] save threw:", err instanceof Error ? err.message : err);
  }
}

function confidenceLabelToScore(label?: "high" | "medium" | "low"): number | null {
  if (!label) return null;
  if (label === "high") return 0.9;
  if (label === "medium") return 0.6;
  return 0.3;
}
