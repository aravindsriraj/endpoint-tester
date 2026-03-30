import { Composio } from "@composio/core";
import { Annotation, StateGraph, START, END, Send } from "@langchain/langgraph";
import type { EndpointDefinition, EndpointReport, TestReport } from "./types";
import { testEndpoint } from "./endpoint-tester";
import { IdCache } from "./utils/id-cache";

/**
 * Builds a toolkit-slug → connected-account-UUID map for a given userId.
 *
 * When GMAIL_AUTH_CONFIG_ID / GOOGLECALENDAR_AUTH_CONFIG_ID (or any *_AUTH_CONFIG_ID)
 * env vars are set, those specific auth configs take priority so we always use the
 * account created by setup.sh rather than a random first-active account.
 *
 * Falls back to first-active-per-toolkit for apps without env overrides.
 */
async function buildAccountMap(
  composio: Composio,
  connectedAccountId: string
): Promise<Record<string, string>> {
  if (connectedAccountId.match(/^ca_/)) return {}; // already a UUID

  try {
    // Use top-level SDK — it returns authConfig.id per account
    const accounts = await composio.connectedAccounts.list({});
    const active = (accounts.items ?? []).filter(
      (a) => a.data?.status === "ACTIVE"
    );

    // Build a set of preferred authConfigIds from env vars (e.g. GMAIL_AUTH_CONFIG_ID)
    const preferredAuthConfigs = new Set<string>();
    for (const [key, val] of Object.entries(process.env)) {
      if (key.endsWith("_AUTH_CONFIG_ID") && val) preferredAuthConfigs.add(val);
    }

    const map: Record<string, string> = {};

    // Pass 1: pick accounts whose authConfig matches a preferred ID
    for (const acc of active) {
      const slug: string | undefined = (acc as any).toolkit?.slug;
      const authConfigId: string | undefined = acc.authConfig?.id;
      if (slug && authConfigId && preferredAuthConfigs.has(authConfigId) && !map[slug]) {
        map[slug] = acc.id;
      }
    }

    // Pass 2: fill any remaining toolkits with the first active account
    for (const acc of active) {
      const slug: string | undefined = (acc as any).toolkit?.slug;
      if (slug && !map[slug]) {
        map[slug] = acc.id;
      }
    }

    return map;
  } catch {
    return {};
  }
}

/**
 * LangGraph orchestrator that fans out one ReAct agent per endpoint, runs them in
 * parallel, and collects the results into a TestReport.
 *
 * Architecture:
 *   START → orchestratorFn (conditional edge, returns N Send objects)
 *         → N × test_endpoint nodes (parallel)
 *         → END (results accumulated via Annotation reducer)
 */
export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const { composio, connectedAccountId, endpoints } = params;

  // Pre-resolve userId → {toolkitSlug: accountUUID} so proxyExecute can use real UUIDs
  const accountMap = await buildAccountMap(composio, connectedAccountId);
  if (Object.keys(accountMap).length > 0) {
    console.log("Resolved connected accounts:", accountMap);
  }

  // Shared ID cache — resolved path params are reused across all agents
  const cache = new IdCache();

  // ── State ──────────────────────────────────────────────────────────────
  // Only the results field lives in graph state; everything else is closed over.
  const OrchestratorAnnotation = Annotation.Root({
    results: Annotation<EndpointReport[]>({
      reducer: (curr, update) => [...curr, ...update],
      default: () => [],
    }),
  });

  // ── Nodes ─────────────────────────────────────────────────────────────

  // Worker node: receives one endpoint via Send, returns the EndpointReport
  const testEndpointNode = async (workerState: { endpoint: EndpointDefinition }) => {
    const report = await testEndpoint(
      workerState.endpoint,
      composio,
      connectedAccountId,
      accountMap,
      endpoints,
      cache
    );
    console.log(
      `[${report.status.toUpperCase()}] ${report.tool_slug} — ${report.response_summary.slice(0, 80)}`
    );
    return { results: [report] };
  };

  // ── Edges ──────────────────────────────────────────────────────────────

  // Fan-out: one Send per endpoint → all test_endpoint nodes run in parallel
  const orchestratorFn = (_state: typeof OrchestratorAnnotation.State) =>
    endpoints.map((ep) => new Send("test_endpoint", { endpoint: ep }));

  // ── Graph ─────────────────────────────────────────────────────────────

  const graph = new StateGraph(OrchestratorAnnotation)
    .addNode("test_endpoint", testEndpointNode)
    .addConditionalEdges(START, orchestratorFn, ["test_endpoint"])
    .addEdge("test_endpoint", END)
    .compile();

  // ── Invoke ────────────────────────────────────────────────────────────

  console.log(`\nStarting endpoint validation for ${endpoints.length} endpoints...\n`);

  const finalState = await graph.invoke({ results: [] });
  const results: EndpointReport[] = finalState.results;

  return {
    timestamp: new Date().toISOString(),
    total_endpoints: endpoints.length,
    results,
    summary: {
      valid: results.filter((r) => r.status === "valid").length,
      invalid_endpoint: results.filter((r) => r.status === "invalid_endpoint").length,
      insufficient_scopes: results.filter((r) => r.status === "insufficient_scopes").length,
      error: results.filter((r) => r.status === "error").length,
    },
  };
}
