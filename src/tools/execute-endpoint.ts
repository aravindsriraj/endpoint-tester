import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Composio } from "@composio/core";
import { suggestClassification } from "../utils/classify";

/**
 * Resolves the actual connected account UUID to use for a given endpoint path.
 * If accountMap is populated (userId case), uses fuzzy toolkit-slug matching.
 * Falls back to the original connectedAccountId if no match is found.
 */
function resolveAccountId(
  path: string,
  connectedAccountId: string,
  accountMap: Record<string, string>
): string {
  if (Object.keys(accountMap).length === 0) return connectedAccountId; // already a UUID

  // Extract the first non-empty path segment: "/gmail/v1/..." → "gmail"
  const firstSeg = path.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";

  for (const [slug, id] of Object.entries(accountMap)) {
    const s = slug.toLowerCase();
    // Exact match, or slug contains the segment, or segment appears in slug
    if (s === firstSeg || s.includes(firstSeg) || firstSeg.includes(s.replace("google", ""))) {
      return id;
    }
  }

  // Fallback: return the first account UUID in the map
  return Object.values(accountMap)[0] ?? connectedAccountId;
}

/**
 * Factory that creates the execute_endpoint tool bound to a specific Composio client.
 * accountMap: toolkit-slug → UUID (pre-resolved from userId in runAgent, empty if already UUID).
 */
export function createExecuteEndpointTool(
  composio: Composio,
  connectedAccountId: string,
  accountMap: Record<string, string> = {}
) {
  return tool(
    async ({ method, path, queryParams, body }) => {
      try {
        const resolvedId = resolveAccountId(path, connectedAccountId, accountMap);
        const parameters = (queryParams ?? []).map((p) => ({
          in: "query" as const,
          name: p.name,
          value: p.value,
        }));

        const result = await (composio.tools as any).proxyExecute({
          endpoint: path,
          method: method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
          connectedAccountId: resolvedId,
          parameters,
          ...(body && Object.keys(body).length > 0 ? { body } : {}),
        });

        const suggestion = suggestClassification(result.status);

        // Truncate large response bodies to avoid overwhelming the context
        let responseData = result.data;
        if (responseData !== null && responseData !== undefined) {
          const jsonStr = JSON.stringify(responseData);
          if (jsonStr.length > 3000) {
            responseData = { _truncated: true, preview: jsonStr.slice(0, 3000) };
          }
        }

        return JSON.stringify({ status: result.status, data: responseData, suggestion });
      } catch (e) {
        return JSON.stringify({ error: String(e), status: null, suggestion: "error" });
      }
    },
    {
      name: "execute_endpoint",
      description:
        "Execute an HTTP API endpoint via the Composio proxy. Returns the HTTP status code and response body. " +
        "IMPORTANT: All {pathParam} placeholders must be substituted with real values before calling. " +
        "Use this to determine if an endpoint exists and is callable.",
      schema: z.object({
        method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]).describe("HTTP method"),
        path: z
          .string()
          .describe(
            "Full API path with all path parameters already substituted. " +
              "Example: /gmail/v1/users/me/messages/abc123 (NOT /gmail/v1/users/me/messages/{messageId})"
          ),
        queryParams: z
          .array(z.object({ name: z.string(), value: z.any() }))
          .optional()
          .describe("Query parameters to include"),
        body: z.record(z.any()).optional().describe("Request body for POST/PUT/PATCH requests"),
      }),
    }
  );
}
