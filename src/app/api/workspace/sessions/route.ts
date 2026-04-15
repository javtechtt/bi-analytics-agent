import { auth } from "@clerk/nextjs/server";
import { createServerSupabase } from "@/lib/supabase/server";
import { getAuthUser } from "@/lib/auth";

/** Ensure user row exists in Supabase (upsert from Clerk). */
async function ensureUser(userId: string) {
  const sb = createServerSupabase();
  const { data: existing } = await sb.from("users").select("id").eq("id", userId).single();
  if (existing) return;

  const profile = await getAuthUser();
  await sb.from("users").upsert({
    id: userId,
    email: profile?.email ?? null,
    display_name: profile?.displayName ?? null,
    avatar_url: profile?.avatarUrl ?? null,
  });
}

/** GET /api/workspace/sessions — list sessions or get active session */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sb = createServerSupabase();

  // Get the most recent active session with file count
  const { data: sessions, error } = await sb
    .from("sessions")
    .select("*")
    .eq("user_id", userId)
    .order("updated_at", { ascending: false })
    .limit(20);

  if (error) {
    console.error("[workspace/sessions] GET error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ sessions: sessions ?? [] });
}

/** POST /api/workspace/sessions — create a new session */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  await ensureUser(userId);

  const body = await request.json().catch(() => ({})) as {
    title?: string;
    outputMode?: string;
  };

  const sb = createServerSupabase();

  // Deactivate any existing active sessions
  await sb
    .from("sessions")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_active", true);

  // Create new session
  const { data: session, error } = await sb
    .from("sessions")
    .insert({
      user_id: userId,
      title: body.title ?? "Untitled Session",
      output_mode: body.outputMode ?? "executive",
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    console.error("[workspace/sessions] POST error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ session });
}
