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
    name: "generate_visual",
    description:
      "Generate a chart/graph specification that will be rendered live in the UI. Use this whenever the user asks to see, visualize, chart, graph, or plot data. Always call run_analysis first to get the data, then call this to visualize it.",
    parameters: {
      type: "object",
      properties: {
        chart_type: {
          type: "string",
          enum: ["bar", "line", "pie", "area", "scatter"],
          description:
            "The type of chart. Use bar for comparisons, line for trends over time, area for cumulative trends, scatter for correlations between two variables, pie ONLY when showing parts of a whole with few categories.",
        },
        title: {
          type: "string",
          description: "Chart title",
        },
        data: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Category or x-axis label" },
              value: { type: "number", description: "Primary value for single-series charts" },
            },
            required: ["label"],
            additionalProperties: true,
          },
          description:
            "Array of data points. For single-series: use {label, value}. For multi-series (e.g. revenue vs profit): use {label, revenue: 100, profit: 25} and set the 'series' parameter.",
        },
        series: {
          type: "array",
          items: { type: "string" },
          description:
            "Names of the numeric fields to plot as separate series. E.g. ['revenue', 'profit'] will render two lines/bars. If omitted, defaults to ['value'].",
        },
        x_label: { type: "string", description: "X-axis label" },
        y_label: { type: "string", description: "Y-axis label" },
      },
      required: ["chart_type", "title", "data"],
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
      return null; // Route to server
  }
}
