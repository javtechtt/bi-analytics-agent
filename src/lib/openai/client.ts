/**
 * Polish phase: centralized OpenAI client factory with role-aware retry +
 * timeout config.
 *
 * Every callsite that talks to OpenAI imports `openai(role)` instead of
 * `new OpenAI()`. The role picks a retry/timeout profile:
 *
 *   - default:   chat completions for composer/classifier/judge/reranker.
 *                3 retries, 60s timeout. Most calls land here.
 *   - embedding: text-embedding-3-small. Small payloads, fast, batch failures
 *                hurt — retry aggressively. 5 retries, 30s timeout.
 *   - vision:    gpt-4o over PDF Files API. Slow (~10-30s per call), large
 *                payloads. Compounding retries blow our 120s server budget,
 *                so retry sparingly. 2 retries, 180s timeout.
 *   - reasoning: o4-mini. Slow, expensive, and retries rarely recover from
 *                a genuine planner/synth issue. 2 retries, 120s timeout.
 *   - realtime:  ephemeral session token. User-blocking — fail fast and let
 *                the client surface the error rather than dragging out a
 *                retry storm in the foreground. 1 retry, 30s timeout.
 *
 * The OpenAI Node SDK retries automatically on 408/409/429/5xx with
 * exponential backoff and jitter. We don't need to wrap with our own retry
 * loop — configuring `maxRetries` is enough.
 *
 * Why a factory instead of a singleton: tests can stub `openai` per call.
 * Also: passing `apiKey` per env makes per-tenant isolation simpler later
 * if that's ever a thing here.
 */

import OpenAI from "openai";

export type OpenAIRole =
  | "default"
  | "embedding"
  | "vision"
  | "reasoning"
  | "realtime";

interface RoleProfile {
  maxRetries: number;
  /** Per-request timeout in ms. The SDK enforces this; outside this window
   *  it throws regardless of retry budget. */
  timeoutMs: number;
}

const PROFILES: Record<OpenAIRole, RoleProfile> = {
  default: { maxRetries: 3, timeoutMs: 60_000 },
  embedding: { maxRetries: 5, timeoutMs: 30_000 },
  vision: { maxRetries: 2, timeoutMs: 180_000 },
  reasoning: { maxRetries: 2, timeoutMs: 120_000 },
  realtime: { maxRetries: 1, timeoutMs: 30_000 },
};

/**
 * Return a configured OpenAI client for the given role. Cheap to construct;
 * callers can hold the result for the duration of a single tool call but
 * don't need to.
 */
export function openai(role: OpenAIRole = "default"): OpenAI {
  const profile = PROFILES[role];
  return new OpenAI({
    maxRetries: profile.maxRetries,
    timeout: profile.timeoutMs,
  });
}
