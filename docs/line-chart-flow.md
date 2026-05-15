# Line Chart — How It's Generated & Where the Data Comes From

A line chart in this app is built in three stages: **upload** (data enters the system), **voice → tool call** (the model decides to chart), and **server build** (the backend aggregates rows into chart points). The model never touches the rows — it only names columns.

## Flow

```mermaid
flowchart TD
    subgraph Upload["①  Upload — data enters the app"]
        File([User drops file<br/>CSV / Excel / PDF])
        Parse["/api/files/parse<br/>Papa Parse · XLSX · pdfjs<br/>(infers numeric / text / date)"]
        State[("React state<br/>parsedData = {columns,<br/>columnTypes, rows[]}")]
        File --> Parse --> State
    end

    subgraph Context["②  Metadata handshake (no rows)"]
        Meta["sendFileContext()<br/>sends: file name + column list +<br/>row count"]
        Model["OpenAI Realtime<br/>gpt-realtime-1.5"]
        State -- "metadata only" --> Meta --> Model
    end

    subgraph Voice["③  User asks for a trend"]
        Mic([🎙 'Show revenue over months'])
        Mic -- "WebRTC audio" --> Model
        Model -- "function_call<br/>create_chart({<br/>  chart_type: 'line',<br/>  metric: 'Revenue',<br/>  group_by: 'Month',<br/>  aggregation: 'sum'<br/>})" --> Hook
        Hook["useRealtimeSession<br/>intercepts tool call"]
    end

    subgraph Build["④  Server builds the chart from the real rows"]
        Exec["/api/tools/execute<br/>buildChart()"]
        Resolve["resolveColumn()<br/>'Revenue' → exact / alias /<br/>case-insensitive match"]
        Filter["optional filter<br/>e.g. Region:West"]
        Order["labelOrder Map<br/>preserves original row order<br/>(so Jan → Feb → Mar, not by value)"]
        Agg["computeGroupBy(rows, groupCol,<br/>metricCol, 'sum')<br/>→ {results, validRows,<br/>totalRows, skippedRows}"]
        Sort["if chart_type === 'line'<br/>sort by labelOrder<br/>(natural sequence, NOT desc)"]
        Cap["slice(0, MAX_CHART_POINTS=100)"]
        Payload["{ chart_type:'line',<br/>title, data:[{label,value},…],<br/>series?, coverage:'847 of 1,000 rows' }"]

        Hook -- "POST {name, args,<br/>parsedData from state}" --> Exec
        Exec --> Resolve --> Filter --> Order --> Agg --> Sort --> Cap --> Payload
    end

    subgraph Render["⑤  Result goes two places"]
        Text["result text →<br/>function_call_output →<br/>model speaks it"]
        Chart["setCharts([...]) →<br/>ChartOverlay / ChartStage<br/>(Recharts <LineChart>)"]
        Payload --> Text
        Payload --> Chart
    end

    classDef model fill:#2d1b4e,stroke:#7c5cff,color:#fff
    classDef server fill:#1b3a2d,stroke:#4ade80,color:#fff
    classDef client fill:#1b2a3a,stroke:#60a5fa,color:#fff
    classDef data fill:#3a2a1b,stroke:#f59e0b,color:#fff
    class Model model
    class Parse,Exec,Resolve,Filter,Order,Agg,Sort,Cap server
    class File,Hook,Chart client
    class State,Meta,Payload data
```

## Where the data comes from — at each step

| Stage | Source | What it holds |
|---|---|---|
| ① Upload | User's uploaded file | Raw bytes, parsed into typed rows by [`/api/files/parse`](../src/app/api/files/parse/route.ts) |
| ② React state | `parsedData` in [page.tsx](../src/app/(app)/page.tsx) | The only live copy of the rows — lives in the browser |
| ③ Model input | [`sendFileContext`](../src/lib/useRealtimeSession.ts#L772) | **Column names + row count only** — no rows cross the wire to OpenAI |
| ④ Tool call body | [useRealtimeSession.ts:298-307](../src/lib/useRealtimeSession.ts#L298-L307) | React sends `parsedData` back to its own server route along with the model's args |
| ⑤ Aggregation | [`buildChart` in execute/route.ts:532](../src/app/api/tools/execute/route.ts#L532) | Groups rows by `Month`, sums `Revenue`, returns `{label, value}[]` |
| ⑥ Render | [ChartOverlay](../src/components/ChartOverlay.tsx) | Recharts `<LineChart>` reads the `data[]` — one point per group |

## Why line charts get special-cased

Bar charts sort descending by value (biggest bar first). Line charts must preserve the **original row order** so Jan → Feb → Mar reads chronologically, not Mar → Jan → Feb. That's what [`labelOrder`](../src/app/api/tools/execute/route.ts#L640-L644) does: it records each group's first appearance and forces a re-sort after aggregation ([execute/route.ts:679-683](../src/app/api/tools/execute/route.ts#L679-L683)).

## What the model never sees

- Raw rows
- Actual values
- Computed aggregates (until they come back as `result` text)

The model's job is to pick `chart_type`, `metric`, `group_by`, and `aggregation` by column name. Everything else is deterministic server code — which is why numbers in the chart always match numbers in the spoken answer.
