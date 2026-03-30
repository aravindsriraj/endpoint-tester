import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { Composio } from "@composio/core";
import type { EndpointDefinition } from "../types";
import type { IdCache } from "../utils/id-cache";

/** Reuse the same account resolution logic from execute-endpoint. */
function resolveAccountId(
  path: string,
  connectedAccountId: string,
  accountMap: Record<string, string>
): string {
  if (Object.keys(accountMap).length === 0) return connectedAccountId;
  const firstSeg = path.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  for (const [slug, id] of Object.entries(accountMap)) {
    const s = slug.toLowerCase();
    if (s === firstSeg || s.includes(firstSeg) || firstSeg.includes(s.replace("google", ""))) {
      return id;
    }
  }
  return Object.values(accountMap)[0] ?? connectedAccountId;
}

/**
 * Factory that creates the resolve_path_param tool.
 * Finds the appropriate list endpoint for a given path parameter and returns a real ID.
 * Results are cached so multiple endpoints needing the same ID only fetch once.
 */
export function createResolvePathParamTool(
  composio: Composio,
  connectedAccountId: string,
  accountMap: Record<string, string> = {},
  allEndpoints: EndpointDefinition[],
  cache: IdCache
) {
  return tool(
    async ({ paramName }) => {
      // 1. Check cache first
      if (cache.has(paramName)) {
        return JSON.stringify({ resolved: true, value: cache.get(paramName), source: "cache" });
      }

      // 2. Derive resource type from param name: "messageId" → "message", "eventId" → "event"
      const resourceType = paramName.replace(/Id$/, "").toLowerCase();

      // 3. Find a list endpoint: GET, no path params, path mentions the resource type
      const listEndpoint = allEndpoints.find(
        (ep) =>
          ep.method === "GET" &&
          !ep.path.includes("{") &&
          ep.path.toLowerCase().includes(resourceType)
      );

      if (!listEndpoint) {
        return JSON.stringify({
          resolved: false,
          error: `No list endpoint found for '${paramName}' (resource type: '${resourceType}')`,
        });
      }

      // 4. Execute the list endpoint to get a real ID
      try {
        const resolvedId = resolveAccountId(listEndpoint.path, connectedAccountId, accountMap);
        const result = await (composio.tools as any).proxyExecute({
          endpoint: listEndpoint.path,
          method: "GET",
          connectedAccountId: resolvedId,
          parameters: [{ in: "query", name: "maxResults", value: 5 }],
        });

        if (result.status < 200 || result.status >= 300) {
          return JSON.stringify({
            resolved: false,
            error: `List endpoint ${listEndpoint.tool_slug} returned HTTP ${result.status}`,
          });
        }

        // 5. Extract first ID from response body
        const extractedId = extractFirstId(result.data, paramName);
        if (extractedId) {
          cache.set(paramName, extractedId);
          return JSON.stringify({
            resolved: true,
            value: extractedId,
            source: listEndpoint.tool_slug,
          });
        }

        return JSON.stringify({
          resolved: false,
          error: "Could not extract an ID from the list response",
          hint: JSON.stringify(result.data).slice(0, 300),
        });
      } catch (e) {
        return JSON.stringify({ resolved: false, error: String(e) });
      }
    },
    {
      name: "resolve_path_param",
      description:
        "Resolve a path parameter placeholder to a real ID by calling the appropriate list endpoint. " +
        "Call this BEFORE execute_endpoint when the endpoint path contains {paramName} placeholders. " +
        "Example: call resolve_path_param({paramName: 'messageId'}) to get a real Gmail message ID, " +
        "then substitute it: /gmail/v1/users/me/messages/REAL_ID",
      schema: z.object({
        paramName: z
          .string()
          .describe(
            "The path parameter name to resolve, e.g. 'messageId', 'eventId', 'threadId', 'calendarId'"
          ),
      }),
    }
  );
}

/**
 * Extracts the first ID-like string value from an API list response.
 * Handles common patterns: { messages: [{id: "..."}] }, { items: [{id: "..."}] }, etc.
 */
function extractFirstId(data: unknown, paramName: string): string | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  // Look for array-valued properties containing objects with IDs
  for (const value of Object.values(obj)) {
    if (Array.isArray(value) && value.length > 0) {
      const item = value[0];
      if (item && typeof item === "object") {
        const itemObj = item as Record<string, unknown>;
        // Try: exact paramName, "id", then any key ending in "Id"
        const candidates = [
          paramName,
          "id",
          ...Object.keys(itemObj).filter((k) => k.toLowerCase().endsWith("id")),
        ];
        for (const key of candidates) {
          if (typeof itemObj[key] === "string" && (itemObj[key] as string).length > 0) {
            return itemObj[key] as string;
          }
        }
      }
    }
  }

  // Direct id field (non-list responses)
  if (typeof obj.id === "string") return obj.id;

  return null;
}
