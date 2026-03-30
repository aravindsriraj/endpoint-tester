import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { ChatAnthropic } from "@langchain/anthropic";
import { HumanMessage } from "@langchain/core/messages";
import type { Composio } from "@composio/core";
import type { EndpointDefinition, EndpointReport, EndpointStatus } from "./types";
import type { IdCache } from "./utils/id-cache";
import { createExecuteEndpointTool } from "./tools/execute-endpoint";
import { createResolvePathParamTool } from "./tools/resolve-path-param";
import { buildDefaultBody } from "./utils/body-builder";

/**
 * Tests a single endpoint using a LangGraph ReAct agent backed by Claude.
 * The agent reasons about request construction, dependency resolution, and classification.
 *
 * @param accountMap  toolkit-slug → UUID map (built from userId resolution in runAgent).
 *                    Empty if connectedAccountId is already a UUID.
 */
export async function testEndpoint(
  endpoint: EndpointDefinition,
  composio: Composio,
  connectedAccountId: string,
  accountMap: Record<string, string>,
  allEndpoints: EndpointDefinition[],
  cache: IdCache
): Promise<EndpointReport> {
  const llm = new ChatAnthropic({
    model: "claude-sonnet-4-6",
    temperature: 0,
    anthropicApiUrl: "https://llmproxy.atlan.dev",
    apiKey: process.env.LITELLM_API_KEY || process.env.ANTHROPIC_API_KEY || "dummy",
  });

  const tools = [
    createExecuteEndpointTool(composio, connectedAccountId, accountMap),
    createResolvePathParamTool(composio, connectedAccountId, accountMap, allEndpoints, cache),
  ];

  const agent = createReactAgent({
    llm,
    tools,
    stateModifier: SYSTEM_PROMPT,
  });

  const pathParams = extractPathParams(endpoint.path);
  const defaultBody = buildDefaultBody(endpoint.parameters.body, endpoint.tool_slug);
  const userMessage = buildUserMessage(endpoint, pathParams, defaultBody);

  try {
    const result = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: 15 }
    );

    return parseAgentResult(result, endpoint);
  } catch (e) {
    return makeErrorReport(endpoint, `Agent execution failed: ${String(e)}`);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function extractPathParams(path: string): string[] {
  return [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
}

function buildUserMessage(
  endpoint: EndpointDefinition,
  pathParams: string[],
  defaultBody: Record<string, unknown> | null
): string {
  const lines: string[] = [
    `Test this API endpoint and classify it:`,
    `  slug:        ${endpoint.tool_slug}`,
    `  method:      ${endpoint.method}`,
    `  path:        ${endpoint.path}`,
    `  description: ${endpoint.description}`,
  ];

  const reqQuery = endpoint.parameters.query.filter((p) => p.required);
  const optQuery = endpoint.parameters.query.filter((p) => !p.required);
  if (reqQuery.length > 0)
    lines.push(`  required query params: ${reqQuery.map((p) => `${p.name}(${p.type})`).join(", ")}`);
  if (optQuery.length > 0 && optQuery.length <= 3)
    lines.push(`  optional query params: ${optQuery.map((p) => p.name).join(", ")}`);

  if (pathParams.length > 0)
    lines.push(`  path params to resolve: ${pathParams.join(", ")} — call resolve_path_param for each`);

  if (endpoint.parameters.body) {
    const reqFields = endpoint.parameters.body.fields.filter((f) => f.required);
    if (reqFields.length > 0)
      lines.push(
        `  required body fields: ${JSON.stringify(reqFields.map((f) => ({ name: f.name, type: f.type })))}`
      );
    if (defaultBody)
      lines.push(`  suggested body payload: ${JSON.stringify(defaultBody)}`);
  }

  return lines.join("\n");
}

const VALID_STATUSES: EndpointStatus[] = [
  "valid",
  "invalid_endpoint",
  "insufficient_scopes",
  "error",
];

const SYSTEM_PROMPT = `You are an API endpoint validator. Determine if the given endpoint is executable.

STEP-BY-STEP WORKFLOW:
1. If the path contains {paramName} placeholders → call resolve_path_param for EACH one first
2. Substitute the resolved IDs into the path string
3. Call execute_endpoint with the complete path, parameters, and body (if needed)
4. Analyze the result and produce a classification

CLASSIFICATION (consider BOTH HTTP status AND response body content):
- "valid"               → any 2xx response; endpoint exists and works
- "invalid_endpoint"    → 404/405, or body says "not found" / "no such endpoint" / "method not allowed"
- "insufficient_scopes" → 401/403, or body says "forbidden" / "insufficient permissions" / "requires scope"
- "error"               → 400 (try to fix and retry ONCE), 5xx, infrastructure errors, or any other failure

RETRY RULE:
- 400 bad request: the issue might be YOUR payload. Re-read the error, fix it, retry once.
- 404 on a path-param endpoint: the ID might be stale. Call resolve_path_param again and retry once.
- Maximum 2 calls to execute_endpoint per endpoint.

DESTRUCTIVE OPS: Use safe minimal payloads — email to self, calendar events 1 month in future.

MANDATORY OUTPUT FORMAT — you MUST end with EXACTLY this JSON object as your final message.
Do NOT add any text, explanation, or markdown before or after it. Output ONLY the JSON:
{"status":"<valid|invalid_endpoint|insufficient_scopes|error>","http_status_code":<number or null>,"response_summary":"<concise reason>","response_body":<response data or null>}

This JSON is required even if all API calls failed. Never skip it. Never wrap it in markdown.`;

function parseAgentResult(
  result: { messages: Array<{ content: unknown }> },
  endpoint: EndpointDefinition
): EndpointReport {
  const lastMessage = result.messages[result.messages.length - 1];
  const content =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  const parsed = extractJSON(content);

  if (parsed && typeof parsed === "object" && "status" in (parsed as object)) {
    const p = parsed as Record<string, unknown>;
    const status = VALID_STATUSES.includes(p.status as EndpointStatus)
      ? (p.status as EndpointStatus)
      : "error";

    return {
      tool_slug: endpoint.tool_slug,
      method: endpoint.method,
      path: endpoint.path,
      status,
      http_status_code:
        typeof p.http_status_code === "number" ? p.http_status_code : null,
      response_summary:
        typeof p.response_summary === "string"
          ? p.response_summary
          : "No summary provided",
      response_body: p.response_body ?? null,
      required_scopes: endpoint.required_scopes,
      available_scopes: [],
    };
  }

  // JSON not found — infer classification from prose response text
  return inferFromProse(content, endpoint);
}

function makeErrorReport(endpoint: EndpointDefinition, message: string): EndpointReport {
  return {
    tool_slug: endpoint.tool_slug,
    method: endpoint.method,
    path: endpoint.path,
    status: "error",
    http_status_code: null,
    response_summary: message,
    response_body: null,
    required_scopes: endpoint.required_scopes,
    available_scopes: [],
  };
}

/**
 * Extracts a JSON object from text that may contain markdown or extra prose.
 * Tries strict parse, code blocks, then greedy multi-line brace matching.
 */
function extractJSON(text: string): unknown {
  // 1. Direct parse
  try { return JSON.parse(text.trim()); } catch {}

  // 2. JSON inside a markdown code block
  const blockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (blockMatch) {
    try { return JSON.parse(blockMatch[1].trim()); } catch {}
  }

  // 3. Greedy: find the last { and try to parse from there to end
  const lastBrace = text.lastIndexOf("{");
  if (lastBrace >= 0) {
    try { return JSON.parse(text.slice(lastBrace)); } catch {}
  }

  // 4. Try each line that starts with { (whole-line JSON)
  for (const line of text.split("\n").reverse()) {
    const t = line.trim();
    if (t.startsWith("{")) {
      try { return JSON.parse(t); } catch {}
    }
  }

  return null;
}

/**
 * When the agent returns prose instead of JSON, infer the classification
 * from keywords in the text. Used as a last-resort fallback.
 */
function inferFromProse(text: string, endpoint: EndpointDefinition): EndpointReport {
  const lower = text.toLowerCase();

  // Try to extract HTTP status code from the prose
  const statusMatch = text.match(/\b(1\d{2}|2\d{2}|3\d{2}|4\d{2}|5\d{2})\b/);
  const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

  let status: EndpointStatus = "error";
  if (httpStatus && httpStatus >= 200 && httpStatus < 300) {
    status = "valid";
  } else if (
    lower.includes("not found") && !lower.includes("connected account not found") ||
    lower.includes("invalid endpoint") ||
    lower.includes("no such") ||
    lower.includes("method not allowed") ||
    httpStatus === 404 || httpStatus === 405
  ) {
    status = "invalid_endpoint";
  } else if (
    lower.includes("forbidden") ||
    lower.includes("insufficient") ||
    lower.includes("scope") ||
    lower.includes("unauthorized") ||
    httpStatus === 403 || httpStatus === 401
  ) {
    status = "insufficient_scopes";
  }

  return {
    tool_slug: endpoint.tool_slug,
    method: endpoint.method,
    path: endpoint.path,
    status,
    http_status_code: httpStatus,
    response_summary: text.slice(0, 300).replace(/\n/g, " "),
    response_body: null,
    required_scopes: endpoint.required_scopes,
    available_scopes: [],
  };
}
