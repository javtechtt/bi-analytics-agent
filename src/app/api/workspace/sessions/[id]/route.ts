import { auth } from "@clerk/nextjs/server";
import { createServerSupabase } from "@/lib/supabase/server";
import type { DbFile, DbMessage, DbChart, DbDashboard } from "@/lib/supabase/types";

type RouteContext = { params: Promise<{ id: string }> };

/** GET /api/workspace/sessions/[id] — full session with all related data */
export async function GET(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sb = createServerSupabase();

  // Verify ownership
  const { data: session } = await sb
    .from("sessions")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  // Fetch all related data in parallel
  const [filesRes, messagesRes, chartsRes, dashboardRes] = await Promise.all([
    sb.from("files").select("*").eq("session_id", id).order("created_at"),
    sb.from("messages").select("*").eq("session_id", id).order("timestamp"),
    sb.from("charts").select("*").eq("session_id", id).order("position"),
    sb.from("dashboards").select("*").eq("session_id", id).single(),
  ]);

  return Response.json({
    session,
    files: (filesRes.data ?? []) as DbFile[],
    messages: (messagesRes.data ?? []) as DbMessage[],
    charts: (chartsRes.data ?? []) as DbChart[],
    dashboard: (dashboardRes.data as DbDashboard) ?? null,
  });
}

/** PUT /api/workspace/sessions/[id] — bulk upsert session state */
export async function PUT(request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sb = createServerSupabase();

  // Verify ownership
  const { data: session } = await sb
    .from("sessions")
    .select("id")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (!session) {
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

  // Upsert messages
  if (body.messages && body.messages.length > 0) {
    await sb.from("messages").delete().eq("session_id", id);
    await sb.from("messages").insert(
      body.messages.map((m) => ({
        session_id: id,
        external_id: m.id,
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
      }))
    );
  }

  // Upsert charts
  if (body.charts && body.charts.length > 0) {
    await sb.from("charts").delete().eq("session_id", id);
    await sb.from("charts").insert(
      body.charts.map((c, i) => ({
        session_id: id,
        external_id: c.id,
        chart_type: c.chart_type,
        title: c.title,
        chart_data: c.data,
        x_label: c.x_label ?? null,
        y_label: c.y_label ?? null,
        series: c.series ?? null,
        coverage: c.coverage ?? null,
        data_summary: c.dataSummary ?? null,
        position: i,
      }))
    );
  }

  // Upsert dashboard
  if (body.dashboard !== undefined) {
    await sb.from("dashboards").delete().eq("session_id", id);
    if (body.dashboard) {
      await sb.from("dashboards").insert({
        session_id: id,
        title: body.dashboard.title,
        subtitle: body.dashboard.subtitle ?? null,
        kpis: body.dashboard.kpis,
        charts: body.dashboard.charts,
        insights: body.dashboard.insights,
        risks: body.dashboard.risks,
        opportunities: body.dashboard.opportunities,
        drilldowns: body.dashboard.drilldowns ?? [],
      });
    }
  }

  // Update session metadata
  await sb.from("sessions").update({
    output_mode: body.outputMode ?? "executive",
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  return Response.json({ ok: true });
}

/** DELETE /api/workspace/sessions/[id] — delete session and all data */
export async function DELETE(_request: Request, context: RouteContext) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  const sb = createServerSupabase();

  // Verify ownership then delete (cascade handles related records)
  const { error } = await sb
    .from("sessions")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ ok: true });
}
