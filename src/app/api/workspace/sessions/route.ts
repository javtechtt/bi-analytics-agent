import { auth } from "@clerk/nextjs/server";
import { getSql } from "@/lib/db";
import { getAuthUser } from "@/lib/auth";

/** Ensure user row exists (upsert from Clerk). */
async function ensureUser(userId: string) {
  const sql = getSql();
  const existing = (await sql`select id from users where id = ${userId}`) as Array<{ id: string }>;
  if (existing.length > 0) return;

  const profile = await getAuthUser();
  await sql`
    insert into users (id, email, display_name, avatar_url)
    values (
      ${userId}, ${profile?.email ?? null}, ${profile?.displayName ?? null},
      ${profile?.avatarUrl ?? null}
    )
    on conflict (id) do update set
      email = excluded.email,
      display_name = excluded.display_name,
      avatar_url = excluded.avatar_url
  `;
}

/** GET /api/workspace/sessions — list sessions or get active session */
export async function GET() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const sql = getSql();
  try {
    const sessions = await sql`
      select * from sessions
      where user_id = ${userId}
      order by updated_at desc
      limit 20
    `;
    return Response.json({ sessions: sessions ?? [] });
  } catch (err) {
    console.error("[workspace/sessions] GET error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "list failed" },
      { status: 500 }
    );
  }
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

  const sql = getSql();

  try {
    // Deactivate any existing active sessions
    await sql`
      update sessions set is_active = false, updated_at = now()
      where user_id = ${userId} and is_active = true
    `;

    // Create new session
    const rows = (await sql`
      insert into sessions (user_id, title, output_mode, is_active)
      values (
        ${userId}, ${body.title ?? "Untitled Session"},
        ${body.outputMode ?? "executive"}, true
      )
      returning *
    `) as Array<Record<string, unknown>>;

    return Response.json({ session: rows[0] });
  } catch (err) {
    console.error("[workspace/sessions] POST error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "create failed" },
      { status: 500 }
    );
  }
}
