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

import { createServerSupabase } from "@/lib/supabase/server";
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
    const sb = createServerSupabase();
    const { error } = await sb.from("scenes").upsert({
      id: scene.id,
      session_id: sessionId,
      document_id: scene.documentId ?? null,
      user_id: userId,
      title: scene.title,
      layout: scene.layout,
      fragments: scene.fragments,
      caption: scene.caption ?? null,
      confidence: confidenceLabelToScore(scene.confidence),
      drilldowns: scene.drilldowns ?? [],
    });
    if (error) {
      console.warn("[scenes/store] save error:", error.message);
    }
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
