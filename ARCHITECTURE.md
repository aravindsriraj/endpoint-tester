# Architecture: API Endpoint Executability Validator

## 1. Design Overview

The agent uses a **LangGraph Orchestrator + Parallel ReAct Agents** pattern. Each endpoint is tested by its own independent Claude-powered agent instance, all running concurrently via LangGraph's `Send` API.

```
runAgent()
  │
  ├─ Creates shared IdCache (path parameter value store)
  │
  └─ LangGraph StateGraph
       │
       START → orchestratorFn
                  └─ Send("test_endpoint", {endpoint}) × N  (parallel fan-out)
                       │
                       ├─ Agent 1: test(GMAIL_LIST_MESSAGES)         → EndpointReport
                       ├─ Agent 2: test(GMAIL_GET_MESSAGE)            → EndpointReport
                       │     └─ resolve_path_param("messageId") first
                       ├─ Agent 3: test(GOOGLECALENDAR_CREATE_EVENT)  → EndpointReport
                       └─ ... × N
                       │
                       results[] accumulated via Annotation reducer
                       │
                       END → TestReport
```

**Per-endpoint agent loop** (via `createReactAgent` + Claude Haiku):
1. User message provides endpoint definition, required body fields, suggested payload
2. If path has `{paramName}` → agent calls `resolve_path_param` tool
3. Agent substitutes resolved IDs into the path string
4. Agent calls `execute_endpoint` tool with constructed params/body
5. If 400 → agent reads error message and retries once with corrected payload
6. Agent produces final JSON classification (status + reasoning)

## 2. Dependency Resolution

Path parameters like `{messageId}` or `{eventId}` are resolved at runtime using a generic "list → pick → cache" pattern:

1. **Normalize**: strip the `Id` suffix to get resource type — `messageId` → `message`
2. **Find list endpoint**: scan all endpoints for `GET` + no `{` in path + path contains the resource type string
3. **Execute list endpoint**: call `proxyExecute()` with `maxResults=5`
4. **Extract ID**: traverse the response for the first array of objects; pick the `id` / any `*Id` field
5. **Cache**: store in the shared `IdCache` singleton — next agent needing `messageId` gets it instantly

**Why this generalizes:** The extraction is purely structural — no app-specific knowledge. For Gmail `messageId`, Calendar `eventId`, Slack `channelId`, Stripe `customerId` — the same traversal logic works. The `IdCache` singleton also ensures the list endpoint is called only once, even when 3 different agents all need `messageId`.

## 3. Avoiding False Negatives

A false negative is when a _valid_ endpoint gets classified as `error` because the agent sent a bad request. Three mitigation layers:

### Layer 1: Pre-built body defaults (`body-builder.ts`)
Type-aware defaults are computed before the agent even starts and passed as a "suggested payload":
- `start`/`end` objects → `{ dateTime: <1 month from now>, timeZone: "UTC" }` (valid Calendar event)
- `raw` field (Gmail send) → base64url RFC 2822 email addressed to self
- `summary`/`title` → `"API Validation Test"`
- `dateTime` strings → ISO 8601, 1 month in the future
- Scalars by type: `string` → `"test"`, `integer` → `1`, `boolean` → `false`

### Layer 2: Retry on 400 (LLM-guided)
If the agent receives a 400 Bad Request, it re-reads the error body, diagnoses what was wrong, and retries once with a corrected payload. A static script can't do this — it would just classify as `error`.

### Layer 3: LLM-based final classification
Claude sees both the HTTP status code AND the full response body. This catches:
- A 400 response body saying "method not supported" → actually `invalid_endpoint`
- A 200 response with an error embedded in JSON → still `valid` (endpoint responded)
- A 403 body saying "insufficient scope" vs "resource not found" → correct classification

## 4. Classification Logic

| Signal | Classification |
|--------|---------------|
| HTTP 2xx | `valid` |
| HTTP 404, 405 | `invalid_endpoint` |
| HTTP 401, 403 | `insufficient_scopes` |
| HTTP 400 (after retry) | `error` |
| HTTP 5xx | `error` |
| Body says "not found" / "does not exist" | `invalid_endpoint` (overrides status) |
| Body says "forbidden" / "insufficient scope" | `insufficient_scopes` (overrides 400) |

The LLM makes the final call using the above as guidelines, applying judgment to ambiguous cases where the status code and body contradict each other.

## 5. Tradeoffs and What I'd Improve

| Tradeoff | Current approach | With more time |
|----------|-----------------|----------------|
| Concurrency | All N agents run simultaneously | `pLimit(10)` semaphore to prevent API rate-limit bursts |
| LLM cost | 1–3 Claude Haiku calls per endpoint | Pre-classify obvious cases (no body, no path params) without LLM |
| DELETE safety | Tries cached ID or fails gracefully | Create resource first via POST, capture ID, delete it, verify |
| Scope detection | HTTP 403 or response body text | Fetch account's actual OAuth scopes upfront, skip pre-known failures |
| Body construction | Heuristic defaults | Parse OpenAPI/JSON Schema properly with a schema library |
| Agent output | Parse JSON from free text | `withStructuredOutput(ClassificationSchema)` for type-safe output |

**Known edge case:** For destructive endpoints where no cached ID exists (e.g., `DELETE /events/{eventId}` if no events exist in the account), the agent may get a 404 and classify as `error`. The correct fix is to first `POST` a resource, capture the returned ID, then delete it — but this requires multi-step coordination not captured in the current tool set.

## 6. Architecture Pattern Rationale

**Why one agent per endpoint (not a single sequential agent)?**

Per the brief: "each endpoint should be tested by its own agent instance." Beyond compliance, this pattern has real advantages:
- **Independence**: each agent fails or succeeds on its own; one bad endpoint can't corrupt another's context
- **Parallelism**: wall-clock time approaches the slowest single endpoint, not the sum of all
- **Clean state**: no shared message history means no context pollution between endpoints

**Why LangGraph instead of plain `Promise.all()`?**

A `Promise.all()` loop could work mechanically, but:
- LangGraph's `Annotation` reducer gives clean, race-condition-free state accumulation
- `createReactAgent` handles the tool-call loop automatically — no boilerplate ReAct loop code
- The ReAct loop enables genuine reasoning: the agent inspects error messages, decides whether to retry, and explains its classification — not just rule-matching

**Why Claude Haiku?**

Each of the N endpoint agents makes 1–3 LLM calls. Haiku is ~10× cheaper than Sonnet while being capable enough for structured API validation tasks. The detailed system prompt compensates for the smaller model's weaker zero-shot reasoning.
