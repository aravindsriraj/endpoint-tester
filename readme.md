# API Endpoint Executability Validator

## The Problem

Composio connects AI agents to 1,000+ external apps and 42,000+ API endpoints. Before an endpoint can be reliably used by an agent, you need to know: **does it actually work?**

This is harder than it sounds. Endpoints can fail for many reasons:
- The endpoint is **fake** — it appears in documentation but doesn't exist in the real API
- The connected account **lacks the required OAuth scopes** to call it
- The endpoint requires **path parameters** (like `{messageId}`) that must be fetched from another endpoint first
- The request **body must be constructed correctly** from a schema, or the API rejects it

Manually testing thousands of endpoints per app is not feasible. This project automates it.

## What It Does

An AI agent that validates whether API endpoints are actually executable. Given a list of endpoint definitions, it tests each one via Composio's proxy and classifies the result as `valid`, `invalid_endpoint`, `insufficient_scopes`, or `error`.

## Architecture

```
runAgent()
  │
  ├── Resolve userId → connected account UUIDs (via .env auth config IDs)
  │
  └── LangGraph StateGraph
        │
        START → fan-out via Send API (all endpoints run in parallel)
          │
          ├── ReAct Agent (endpoint 1) ─── execute_endpoint + resolve_path_param tools
          ├── ReAct Agent (endpoint 2) ─── ...
          └── ReAct Agent (endpoint N) ─── ...
          │
          └── Reducer merges all EndpointReports → TestReport → report.json
```

- **LangGraph orchestrator** fans out one Claude-powered ReAct agent per endpoint using the `Send` API — all run concurrently
- **`execute_endpoint` tool** wraps `composio.tools.proxyExecute()` for authenticated API calls with automatic OAuth
- **`resolve_path_param` tool** dynamically resolves path parameters like `{messageId}` by calling the appropriate list endpoint and caching results in a shared `IdCache`
- **LLM-based classification** — Claude reads both HTTP status code and response body to decide the final status, handling edge cases like 400s that should retry, scope errors hidden in 400 responses, stale IDs, etc.

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for full design documentation.

## Prerequisites

- [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)
- [Composio](https://app.composio.dev) account and API key
- LiteLLM gateway URL + API key **or** Anthropic API key (for Claude)
- A Google account to connect via OAuth (Gmail + Google Calendar)

## Setup

### 1. Add your API keys to `.env`

Create a `.env` file in the project root:

```bash
# Composio — get from https://app.composio.dev
COMPOSIO_API_KEY=your_composio_api_key

# LiteLLM gateway (recommended)
LITELLM_API_KEY=sk-...

# OR use Anthropic directly (remove anthropicApiUrl in src/endpoint-tester.ts)
# ANTHROPIC_API_KEY=sk-ant-...
```

### 2. Run setup

```bash
COMPOSIO_API_KEY=your_key sh setup.sh
```

`setup.sh` does everything in one shot:
- Installs dependencies via `bun install`
- Runs `scaffold.sh` to create managed OAuth auth configs for Gmail and Google Calendar and writes their IDs to `.env`
- Runs `bun src/connect.ts` — prints OAuth URLs to connect your Google account; open them in your browser and sign in
- Runs a sanity check to verify `proxyExecute()` works end-to-end

> **Tip:** Use a throwaway Google account — the agent sends a test email to self and may trash messages or delete calendar events during validation.

### 3. Verify

```bash
bun src/index.ts
```

Prints all endpoint definitions and required OAuth scopes.

## Running the Agent

```bash
bun src/run.ts
```

The agent tests all endpoints in `src/endpoints.json` in parallel, prints a live result per endpoint, and writes the final report to `report.json`.

**Example output:**

```
Starting endpoint validation for 16 endpoints...

[VALID] GMAIL_LIST_MESSAGES — Returned 5 messages with IDs and threadIds
[VALID] GMAIL_GET_MESSAGE — Successfully retrieved the specified Gmail message
[VALID] GMAIL_TRASH_MESSAGE — Message successfully moved to trash
[INVALID_ENDPOINT] GMAIL_LIST_FOLDERS — /gmail/v1/users/me/folders does not exist in the Gmail API
[INVALID_ENDPOINT] GMAIL_ARCHIVE_MESSAGE — The /archive sub-path does not exist in the Gmail API
...

Agent completed in 51s.
✓ Report validation passed.

  Valid:               11
  Invalid endpoint:     4
  Insufficient scopes:  0
  Error:                1
  Total:               16

Report written to report.json
```

## Project Structure

```
src/
├── agent.ts                  # runAgent() — LangGraph orchestrator entry point
├── endpoint-tester.ts        # per-endpoint createReactAgent (Claude + tools)
├── tools/
│   ├── execute-endpoint.ts   # proxyExecute() wrapper as LangChain tool
│   └── resolve-path-param.ts # generic path parameter dependency resolver
├── utils/
│   ├── id-cache.ts           # shared singleton for resolved path param IDs
│   ├── classify.ts           # HTTP status → classification hint helper
│   └── body-builder.ts       # type-aware default request body generator
├── types.ts                  # EndpointDefinition, EndpointReport, TestReport types
├── endpoints.json            # sample endpoints (Gmail + Google Calendar)
├── run.ts                    # runner and report validator (read-only)
├── connect.ts                # OAuth setup for the 'candidate' user
└── index.ts                  # endpoint list display utility
scaffold.sh                   # creates Composio auth configs, writes IDs to .env
setup.sh                      # one-shot setup: install → scaffold → OAuth → sanity check
ARCHITECTURE.md               # full architecture documentation
```

## How False Negatives Are Prevented

A false negative is when a valid endpoint gets misclassified as broken because the agent made a bad request.

| Risk | Mitigation |
|---|---|
| Bad request body | `body-builder.ts` generates type-aware defaults (e.g. real base64url RFC 2822 email for Gmail send) |
| Wrong field values | Agent retries once on 400 after reading the error message |
| Made-up path param IDs | `resolve_path_param` fetches real IDs from list endpoints before calling detail/mutation endpoints |
| Stale cached IDs | Agent detects 404 on path-param endpoints, re-fetches a fresh ID, and retries |
| 400 that's actually a scope error | Claude reads body text — "insufficient_scope" → `insufficient_scopes`, not `error` |

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | [Bun](https://bun.sh) + TypeScript |
| Orchestration | [LangGraph](https://langchain-ai.github.io/langgraphjs/) (StateGraph + Send API) |
| LLM | Claude Sonnet 4.6 via [LiteLLM](https://docs.litellm.ai) gateway |
| API proxy + OAuth | [Composio](https://composio.dev) `proxyExecute` |
| Tool framework | LangChain `createReactAgent` + `tool()` |
