import { auth } from "@clerk/nextjs/server";
import { getSql, toJsonb, buildValues } from "@/lib/db";
import type { DbFile, DbMessage, DbChart, DbDashboard } from "@/lib/supabase/types";

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/workspace/sessions/[id] — full session with all related data */
export async function GET(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sql = getSql();

  // Verify ownership
  const sessionRows = (await sql`
    select * from sessions where id = ${id} and user_id = ${userId}
  `) as Array<Record<string, unknown>>;
  const session = sessionRows[0];
  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  // Fetch all related data in parallel
  const [files, messages, charts, dashboards] = await Promise.all([
    sql`select * from files where session_id = ${id} order by created_at`,
    sql`select * from messages where session_id = ${id} order by timestamp`,
    sql`select * from charts where session_id = ${id} order by position`,
    sql`select * from dashboards where session_id = ${id} limit 1`,
  ]);

  return Response.json({
    session,
    files: files as DbFile[],
    messages: messages as DbMessage[],
    charts: charts as DbChart[],
    dashboard: ((dashboards as DbDashboard[])[0]) ?? null,
  });
}

/** PUT /api/workspace/sessions/[id] — bulk upsert session state */
export async function PUT(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sql = getSql();

  // Verify ownership
  const ownRows = (await sql`
    select id from sessions where id = ${id} and user_id = ${userId}
  `) as Array<{ id: string }>;
  if (ownRows.length === 0) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  const body = await request.json() as {
    messages?: Array<{ id: string; role: string; content: string; timestamp: number }>;
    charts?: Array<{
      id: string; chart_type: string; title: string;
      data: unknown; x_label?: string; y_label?: string;
      series?: string[]; coverage?: string; dataSummary?: string;
    }>;
    dashboard?: {
      title: string; subtitle?: string;
      kpis: unknown; charts: unknown; insights: unknown;
      risks: unknown; opportunities: unknown; drilldowns?: unknown;
    } | null;
    outputMode?: string;
  };

  // Upsert messages (replace-all)
  if (body.messages && body.messages.length > 0) {
    await sql`delete from messages where session_id = ${id}`;
    const { text, params } = buildValues(
      body.messages.map((m) => [id, m.id, m.role, m.content, m.timestamp])
    );
    await sql.query(
      `insert into messages (session_id, external_id, role, content, timestamp) values ${text}`,
      params
    );
  }

  // Upsert charts (replace-all)
  if (body.charts && body.charts.length > 0) {
    await sql`delete from charts where session_id = ${id}`;
    const { text, params } = buildValues(
      body.charts.map((c, i) => [
        id,
        c.id,
        c.chart_type,
        c.title,
        toJsonb(c.data),
        c.x_label ?? null,
        c.y_label ?? null,
        toJsonb(c.series ?? null),
        c.coverage ?? null,
        c.dataSummary ?? null,
        i,
      ]),
      ["", "", "", "", "::jsonb", "", "", "::jsonb", "", "", ""]
    );
    await sql.query(
      `insert into charts (
        session_id, external_id, chart_type, title, chart_data, x_label,
        y_label, series, coverage, data_summary, position
      ) values ${text}`,
      params
    );
  }

  // Upsert dashboard (replace-all, one per session)
  if (body.dashboard !== undefined) {
    await sql`delete from dashboards where session_id = ${id}`;
    if (body.dashboard) {
      const d = body.dashboard;
      await sql`
        insert into dashboards (
          session_id, title, subtitle, kpis, charts, insights, risks,
          opportunities, drilldowns
        ) values (
          ${id}, ${d.title}, ${d.subtitle ?? null},
          ${toJsonb(d.kpis)}::jsonb, ${toJsonb(d.charts)}::jsonb,
          ${toJsonb(d.insights)}::jsonb, ${toJsonb(d.risks)}::jsonb,
          ${toJsonb(d.opportunities)}::jsonb, ${toJsonb(d.drilldowns ?? [])}::jsonb
        )
      `;
    }
  }

  // Update session metadata
  await sql`
    update sessions set output_mode = ${body.outputMode ?? "executive"}, updated_at = now()
    where id = ${id}
  `;

  return Response.json({ ok: true });
}

/** DELETE /api/workspace/sessions/[id] — delete session and all data */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sql = getSql();

  // Cascade deletes related files/messages/charts/dashboards/documents/scenes.
  try {
    await sql`delete from sessions where id = ${id} and user_id = ${userId}`;
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "delete failed" },
      { status: 500 }
    );
  }

  return Response.json({ ok: true });
}
