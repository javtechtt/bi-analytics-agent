import { auth } from "@clerk/nextjs/server";
import { getSql, toJsonb } from "@/lib/db";

/** POST /api/workspace/files — save a parsed file record */
export async function POST(request: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json() as {
    sessionId: string;
    file: {
      id: string;
      name: string;
      size: number;
      sizeLabel: string;
      mimeType: string;
      status: string;
      content?: string;
      summary?: string;
      parsedData?: unknown;
      error?: string;
      storagePath?: string;
    };
  };

  const sql = getSql();

  // Verify session ownership
  const sessionRows = (await sql`
    select id from sessions where id = ${body.sessionId} and user_id = ${userId}
  `) as Array<{ id: string }>;
  if (sessionRows.length === 0) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  try {
    const rows = (await sql`
      insert into files (
        id, session_id, user_id, name, size, size_label, mime_type, status,
        content, summary, parsed_data, error, storage_path
      ) values (
        ${body.file.id}, ${body.sessionId}, ${userId}, ${body.file.name},
        ${body.file.size}, ${body.file.sizeLabel}, ${body.file.mimeType ?? null},
        ${body.file.status}, ${body.file.content ?? null}, ${body.file.summary ?? null},
        ${toJsonb(body.file.parsedData ?? null)}::jsonb, ${body.file.error ?? null},
        ${body.file.storagePath ?? null}
      )
      on conflict (id) do update set
        session_id = excluded.session_id,
        user_id = excluded.user_id,
        name = excluded.name,
        size = excluded.size,
        size_label = excluded.size_label,
        mime_type = excluded.mime_type,
        status = excluded.status,
        content = excluded.content,
        summary = excluded.summary,
        parsed_data = excluded.parsed_data,
        error = excluded.error,
        storage_path = excluded.storage_path
      returning id
    `) as Array<{ id: string }>;
    return Response.json({ fileId: rows[0]?.id ?? body.file.id });
  } catch (err) {
    console.error("[workspace/files] POST error:", err);
    return Response.json(
      { error: err instanceof Error ? err.message : "insert failed" },
      { status: 500 }
    );
  }
}
