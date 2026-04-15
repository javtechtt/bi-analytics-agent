import { auth } from "@clerk/nextjs/server";
import { createServerSupabase } from "@/lib/supabase/server";

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

  const sb = createServerSupabase();

  // Verify session ownership
  const { data: session } = await sb
    .from("sessions")
    .select("id")
    .eq("id", body.sessionId)
    .eq("user_id", userId)
    .single();

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const { data: file, error } = await sb
    .from("files")
    .upsert({
      id: body.file.id,
      session_id: body.sessionId,
      user_id: userId,
      name: body.file.name,
      size: body.file.size,
      size_label: body.file.sizeLabel,
      mime_type: body.file.mimeType,
      status: body.file.status,
      content: body.file.content ?? null,
      summary: body.file.summary ?? null,
      parsed_data: body.file.parsedData ?? null,
      error: body.file.error ?? null,
      storage_path: body.file.storagePath ?? null,
    })
    .select("id")
    .single();

  if (error) {
    console.error("[workspace/files] POST error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ fileId: file?.id ?? body.file.id });
}
