import { auth } from "@clerk/nextjs/server";
import { createServerSupabase } from "@/lib/supabase/server";

type RouteContext = { params: Promise<{ id: string }> };

/** DELETE /api/workspace/files/[id] — remove file record + storage blob */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sb = createServerSupabase();

  // Get the file to check ownership and storage path
  const { data: file } = await sb
    .from("files")
    .select("id, user_id, storage_path")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (!file) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  // Delete from storage if path exists
  if (file.storage_path) {
    await sb.storage.from("user-files").remove([file.storage_path]);
  }

  // Delete the database record
  await sb.from("files").delete().eq("id", id);

  return Response.json({ ok: true });
}
