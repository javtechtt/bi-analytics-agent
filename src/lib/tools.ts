import type { UploadedFile } from "./types";

// ── Tool schemas (sent to OpenAI in session config) ──────

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    name: "list_uploaded_files",
    description:
      "List all files the user has uploaded in this session, with their names, sizes, types, and parsing status. Call this when you need to know what data is available.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "profile_dataset",
    description:
      "Get a complete overview of a CSV or Excel dataset: column names, types (numeric/text/date), null counts, unique values, numeric stats (min/max/mean/median/sum), and 5 sample rows. This is your primary tool for understanding a file — call it BEFORE run_analysis.",
    parameters: {
      type: "object",
      properties: {
        file_name: {
          type: "string",
          description: "The name of the file to profile",
        },
      },
      required: ["file_name"],
    },
  },
  {
    type: "function",
    name: "run_analysis",
    description:
      "Run a data analysis operation on an uploaded CSV or Excel file. Supports: filter rows, group-by with aggregation (sum/count/avg/min/max), sort, and top/bottom N. Use this to answer specific data questions.",
    parameters: {
      type: "object",
      properties: {
        file_name: {
          type: "string",
          description: "The name of the file to analyze",
        },
        operation: {
          type: "string",
          enum: ["filter", "group_by", "sort", "top_n"],
          description: "The type of analysis operation",
        },
        column: {
          type: "string",
          description: "The primary column to operate on",
        },
        value: {
          type: "string",
          description:
            "For filter: the value to match. For top_n: the number of rows (e.g. '10').",
        },
        group_by_column: {
          type: "string",
          description: "For group_by: the column to group by",
        },
        aggregation: {
          type: "string",
          enum: ["sum", "count", "avg", "min", "max"],
          description: "For group_by: the aggregation function to apply",
        },
        sort_order: {
          type: "string",
          enum: ["asc", "desc"],
          description: "For sort: the sort direction. Defaults to desc.",
        },
      },
      required: ["file_name", "operation"],
    },
  },
  {
    type: "function",
    name: "create_chart",
    description:
      "Render a chart from the uploaded dataset. The backend builds the chart data — you only specify WHAT to chart, not the data itself. Call this automatically whenever a visual would help. Do NOT pass raw data arrays — just specify the metric and grouping columns.",
    parameters: {
      type: "object",
      properties: {
        chart_type: {
          type: "string",
          enum: ["bar", "line", "pie", "scatter"],
          description:
            "bar: comparing categories. line: trends over time. pie: parts of a whole (≤7 categories). scatter: correlation between two numeric columns.",
        },
        title: {
          type: "string",
          description: "Short chart title",
        },
        metric: {
          type: "string",
          description:
            "The numeric column(s) to measure. For a single metric: 'Revenue'. For multi-series comparison: 'Revenue,Profit' (comma-separated). The chart will render one line/bar per metric.",
        },
        group_by: {
          type: "string",
          description:
            "The column to group/categorize by (x-axis). E.g. 'Region', 'Month', 'Product'.",
        },
        aggregation: {
          type: "string",
          enum: ["sum", "count", "avg", "min", "max"],
          description:
            "How to aggregate each metric within each group. Defaults to 'sum'. Use 'count' to count occurrences.",
        },
        split_by: {
          type: "string",
          description:
            "Optional column to split into multiple lines/bars. Each unique value becomes its own colored series. E.g. split_by='Campaign' with group_by='Month' and metric='Revenue' shows one line per campaign over time.",
        },
        filter: {
          type: "string",
          description:
            "Optional filter in format 'column:value' to chart a subset. E.g. 'Region:West' or 'Year:2024'.",
        },
      },
      required: ["chart_type", "title", "metric", "group_by"],
    },
  },
  {
    type: "function",
    name: "recommend_actions",
    description:
      "Generate actionable business recommendations with impact projections. Call this when the user asks 'what should I do?', 'how can I improve?', 'what's the best move?', or wants strategic advice. Returns prioritized actions with revenue/profit impact estimates and strategy comparisons.",
    parameters: {
      type: "object",
      properties: {
        file_name: {
          type: "string",
          description: "The name of the file to analyze for recommendations",
        },
      },
      required: ["file_name"],
    },
  },
  {
    type: "function",
    name: "compare_files",
    description:
      "Compare two uploaded files side by side. Call this ONLY when the user explicitly asks to compare, contrast, or combine two specific files. Returns KPI comparison, charts with both datasets overlaid, and compatibility analysis. Do NOT call this for single-file analysis.",
    parameters: {
      type: "object",
      properties: {
        file_name_a: {
          type: "string",
          description: "Name of the first file to compare",
        },
        file_name_b: {
          type: "string",
          description: "Name of the second file to compare",
        },
      },
      required: ["file_name_a", "file_name_b"],
    },
  },
  {
    type: "function",
    name: "generate_dashboard",
    description:
      "Generate a full executive BI summary dashboard from the active dataset. Automatically selects the best KPIs, charts, insights, risks, and opportunities. Call this when the user asks for an overview, summary, or dashboard of their data. Do NOT call this for specific questions — use run_analysis or create_chart instead.",
    parameters: {
      type: "object",
      properties: {
        file_name: {
          type: "string",
          description: "The name of the file to build the dashboard from",
        },
      },
      required: ["file_name"],
    },
  },
];

// ── Client-side tool execution ───────────────────────────

export function executeClientTool(
  name: string,
  _args: Record<string, unknown>,
  files: UploadedFile[] | undefined | null
): { result: string } | null {
  const safeFiles = Array.isArray(files) ? files : [];

  switch (name) {
    case "list_uploaded_files": {
      if (safeFiles.length === 0) {
        return { result: "No files have been uploaded yet." };
      }
      const list = safeFiles.map(
        (f) =>
          `- ${f.name} (${f.sizeLabel}, ${f.type || "unknown type"}, status: ${f.status})`
      );
      return { result: `Uploaded files:\n${list.join("\n")}` };
    }

    default:
      return null;
  }
}
