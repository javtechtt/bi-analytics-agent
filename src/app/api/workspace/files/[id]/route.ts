import { auth } from "@clerk/nextjs/server";
import { getSql } from "@/lib/db";

type RouteContext = { params: Promise<{ id: string }> };

/** DELETE /api/workspace/files/[id] — remove file record */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sql = getSql();

  // Ownership check, then delete. (No object storage is wired up, so there's
  // no blob to remove — the record is the whole file.)
  const rows = (await sql`
    select id from files where id = ${id} and user_id = ${userId}
  `) as Array<{ id: string }>;
  if (rows.length === 0) {
    return Response.json({ error: "File not found" }, { status: 404 });
  }

  await sql`delete from files where id = ${id} and user_id = ${userId}`;

  return Response.json({ ok: true });
}
