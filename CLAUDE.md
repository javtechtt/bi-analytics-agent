@AGENTS.md

# BI Analytics Agent — Project Context

## Product Vision
Voice-first AI business intelligence analyst. User speaks, assistant analyzes data, shows charts, and guides decisions — all through natural conversation. The assistant IS the product. Not a dashboard tool with AI bolted on.

## Tech Stack
- Next.js 16.2.3 (Turbopack) + TypeScript + Tailwind CSS v4
- OpenAI Realtime API (model: gpt-realtime-1.5) via WebRTC
- GA endpoint: POST /v1/realtime/calls (NOT /v1/realtime — that's the beta endpoint)
- Ephemeral tokens via client.realtime.clientSecrets.create()
- Recharts for charts, html-to-image for PNG export, unpdf for PDF parsing
- No framer-motion or zustand (removed — unused)

## Architecture

### Files & Layers
```
src/
├── app/
│   ├── page.tsx                    ← Main page, state orchestration
│   ├── layout.tsx                  ← Root layout
│   ├── globals.css                 ← Design system tokens, animations
│   └── api/
│       ├── realtime/session/route.ts  ← Session creation + system prompt (7 tools)
│       ├── files/parse/route.ts       ← CSV/Excel/PDF parsing
│       └── tools/execute/route.ts     ← All tool execution (profile, analyze, chart, dashboard, compare, recommend)
├── components/
│   ├── VoiceOrb.tsx               ← Neural sphere (canvas, fibonacci, lerped states)
│   ├── Starfield.tsx              ← Background canvas (320 stars, 5 nebulae)
│   ├── ChartOverlay.tsx           ← ChartCard component (bar/line/area/pie/scatter, multi-series)
│   ├── ChartStage.tsx             ← Multi-chart layout with KPI row + drill-downs
│   ├── DashboardView.tsx          ← Full-screen AI dashboard (KPIs + charts + insights + export)
│   ├── DocumentPanel.tsx          ← File upload (drag-drop, status indicators)
│   ├── TranscriptOverlay.tsx      ← Voice transcript (bottom overlay)
│   ├── SessionStatus.tsx          ← Connection indicator
│   ├── ModeSelector.tsx           ← Output mode (Executive/Analyst/Sales/Operations)
│   ├── KpiCards.tsx               ← KPI card row with deltas
│   └── DrilldownChips.tsx         ← Clickable follow-up suggestions
└── lib/
    ├── useRealtimeSession.ts      ← WebRTC hook (connection, tools, charts, dashboard, drilldowns)
    ├── tools.ts                   ← 7 tool definitions for OpenAI
    ├── types.ts                   ← ParsedData, UploadedFile, OrbState, OutputMode
    ├── insights.ts                ← Insight engine (trends, anomalies, concentration, efficiency, quality)
    ├── decisions.ts               ← Decision layer (data-grounded projections, strategies)
    ├── dashboard.ts               ← Dashboard generator (KPIs + charts + insights)
    ├── comparison.ts              ← Multi-file comparison engine
    ├── kpi.ts                     ← KPI selection with period-over-period deltas
    ├── labels.ts                  ← Human-friendly label formatting
    ├── pdf-table-extractor.ts     ← Positional PDF table extraction
    ├── export.ts                  ← PNG export (html-to-image, 3x resolution)
    └── cn.ts                      ← clsx + tailwind-merge utility
```

### 7 Tools (registered with OpenAI)
1. list_uploaded_files — client-side, returns file names/sizes/status
2. profile_dataset — server-side, column stats + sample rows + confidence
3. run_analysis — server-side, filter/group_by/sort/top_n with data coverage reporting
4. create_chart — server-side, builds chart data from metric+group_by+split_by
5. recommend_actions — server-side, data-grounded projections + strategies
6. compare_files — server-side, multi-file KPI comparison + overlaid charts
7. generate_dashboard — server-side, auto-selects KPIs + charts + insights + risks

### Data Flow
Upload → parse route (CSV/Excel/PDF) → parsedData stored in React state → tools receive parsedData via fetch body → server computes → result text + chart/dashboard sent back → assistant speaks from result text (source of truth)

### Key Design Decisions
- Model sends column names only for charts (metric, group_by, split_by) — backend builds all chart data. No raw data arrays from the model.
- Structured insights: every insight has observation → implication → recommendation
- Data quality gate: blocks recommendations if <50 rows or >25% missing primary metric
- Seasonality detection via autocorrelation (lags 4/12/6/3) — seasonal spikes suppressed from anomaly detector
- All projections use actual dataset values (linear regression slopes, segment gaps, anomaly magnitudes) — no fixed percentage multipliers
- Every recommendation includes explicit assumptions array
- Response lifecycle tracking prevents conversation_already_has_active_response errors
- File content wrapped in ---BEGIN/END FILE DATA--- markers for prompt injection protection
- Chart keys prefixed with chart.id to prevent React duplicate key errors in multi-chart views

### System Prompt Structure (session/route.ts)
12 numbered sections: Role/Task → Data Isolation → Silent Execution → Voice/Tone → Tools (7) → Source of Truth → Visual Reasoning → Drill-downs → Proactive Next Steps → Confidence Communication → PDF Handling → Honesty → Greeting

Plus mode-specific lenses appended: Executive/Analyst/Sales/Operations

### Known Patterns
- `resolveFile()` in useRealtimeSession.ts auto-picks latest file if model omits file_name
- `resolveColumn()` in tools/execute/route.ts does exact → case-insensitive → partial → reverse partial → semantic alias matching
- `computeGroupBy()` returns `{ results, totalRows, validRows, skippedRows }` — never silently drops data
- Line charts re-sort by original data order (not value-descending like bar charts)
- Dataset cache (5 min TTL) + aggregation cache + profile cache in tools/execute/route.ts
- Rate limiting: 30 calls/minute on /api/tools/execute

### PDF Parsing
- Uses positional extraction: pdfjs getTextContent() → x/y coordinates → cluster rows → detect column boundaries → extract cells
- The parse route handles all pdfjs imports (serverExternalPackages configured) — pdf-table-extractor.ts receives plain objects only
- Column normalization: 15 business concept groups with 80+ aliases
- Falls back to raw text if no tables detected (extractionMethod: "none")

### Confidence Scoring
Computed from: extraction method (CSV>Excel>PDF), sample size, data completeness, schema clarity, resolution certainty. Appended to every tool result. Assistant adjusts tone: high=assertive, medium=cautious, low=transparent.

### Export
- html-to-image at 3x pixel ratio
- data-export-hidden attribute hides UI controls during capture
- 200ms delay before capture to ensure chart SVGs render
- Chart cards and dashboard both exportable as PNG
