# Protocol, Runtime Paths & Third-Party Extension Guide

This document describes the stable wire contract (`protocolVersion: 3`), runtime directory resolution, Native Gemini 4 signature envelopes, streaming error boundaries, and the frontend `window.STVertexPayGo` (`apiVersion: 1`) collaboration API shared by `ST-Vertex-PayGo` and `ST-Vertex-PayGo-Server`.

---

## 1. Runtime Directories & Environment Variables

To keep read-only application roots clean (e.g., Docker containers, packaged installers, and multi-instance hosts), the server plugin resolves runtime paths dynamically instead of hardcoding `process.cwd()`.

| Artifact | Resolution priority (highest to lowest) |
| :--- | :--- |
| **Diagnostic log** (`st-vertex-paygo.log`) | `ST_VERTEX_PAYGO_LOG_DIR` -> `ST_VERTEX_PAYGO_DATA_DIR` -> `<hostDataRoot>/vertex-paygo` -> `process.cwd()` |
| **Bridge port config** (`st-vertex-paygo-bridge.json`) | `ST_VERTEX_PAYGO_DATA_DIR` -> `<hostDataRoot>/vertex-paygo` -> `process.cwd()` |

- **Host `dataRoot` detection**: Reads `COMMAND_LINE_ARGS.dataRoot` or `DATA_ROOT` exposed by SillyTavern / Luker, resolves it against the host root, and ensures `<dataRoot>/vertex-paygo` exists (`0o700` on POSIX).
- **Symlink protection**: Target and ancestor runtime directories are checked with `lstat` and symlinked paths are rejected.
- **Legacy bridge config migration**: When `<configDir>/st-vertex-paygo-bridge.json` does not exist yet (`ENOENT`) and `<hostRoot>/st-vertex-paygo-bridge.json` exists, the server validates and reads the legacy file and performs a best-effort copy to `<configDir>`. Invalid legacy files still fail explicitly (`BRIDGE_CONFIG_INVALID`).
- **Read-only filesystem degradation**:
  - If `st-vertex-paygo.log` cannot be created or opened due to `EROFS`, `EACCES`, `EPERM`, or `ENOENT`, `LogStore` degrades gracefully (`disabled: true`, single `console.warn`, `GET /logs` returns an empty string) instead of blocking plugin startup.
  - If neither `<configDir>` nor `<hostRoot>` has a bridge config and creating the default file fails on a read-only directory, the plugin falls back to the in-memory default port (`18443`) without throwing `503`.

---

## 2. Stable HTTP Contract (`protocolVersion: 3`)

Breaking wire changes increment `protocolVersion`. Additive optional request fields and query parameters remain backward-compatible within `protocolVersion: 3`.

### 2.1 `GET /api/plugins/vertex-paygo/health`

Returns server readiness, `protocolVersion: 3`, `transport: "loopback-http"`, and feature capability flags (including `capabilities.vertexMultiRegions: ["us", "eu"]`, `capabilities.nativeGemini4`, `capabilities.updater`, `capabilities.dataBackups`, and OpenAI bridge flags).

### 2.2 `POST /api/plugins/vertex-paygo/prepare`

Issues a single-use, 5-minute loopback proxy ticket bound to the authenticated host user.

**Request fields**:

- Required core fields: `protocolVersion` (`3`), `chat_completion_source` (`"vertexai" | "makersuite"`), `model`, `stream`, `tier` (`"standard" | "flex" | "priority"`), `paygoOnly` (`boolean`, Vertex AI only).
- Vertex AI fields (when `chat_completion_source === "vertexai"`): `vertexai_auth_mode`, `vertexai_region`, `vertexai_express_project_id`.
  - **Upstream endpoint routing**: `global` targets `https://aiplatform.googleapis.com`; multi-regions `us` and `eu` target Google's Representative Endpoints `https://aiplatform.{us|eu}.rep.googleapis.com` with `/projects/{project}/locations/{us|eu}/...` (`v1`, rewritten to `v1beta1` for Gemini 4); single regions target `https://{region}-aiplatform.googleapis.com`.
  - **Multi-region authentication policy**: Official (`!reverse_proxy`) `us` and `eu` endpoints require Full service-account authentication (`vertexai_auth_mode === "full"`). Express API-key requests on `us` / `eu` are rejected with `400 VERTEX_MULTI_REGION_REQUIRES_FULL_AUTH` (`details: { authMode: "express", region }`); when an explicit `secret_id` is supplied (e.g., Connection Manager profiles that omit `vertexai_auth_mode`), the server inspects the host secret bucket first and allows service-account credentials while rejecting Express keys. Flex and Priority still fail first with `409 GLOBAL_REGION_REQUIRED` on any non-`global` region.
- Optional host credential selector: `secret_id`.
- Optional upstream routing overrides:
  - `reverse_proxy` (+ `proxy_password`): Standard SillyTavern reverse-proxy mode. Credentials come from `proxy_password` (or host proxy behavior) rather than Google official secrets.
  - `base_url` (**optional, `makersuite` only when `reverse_proxy` is absent**): Supports custom AI Studio base URLs (such as Luker's `base_url` field) while **still requiring and reading the user's saved MakerSuite API key** (`SECRET_KEYS.MAKERSUITE` / `secret_id`). Validated with the same `http:` / `https:` origin-and-prefix rules as `reverse_proxy` (credentials, query string, and hash are rejected). When `reverse_proxy` or `base_url` is set, custom proxy model names matching `gemini-*` are accepted.
- Optional usage ledger metadata: `usageChatId`, `usagePrice` (immutable price snapshot in USD per 1M tokens, or `null`).

**Response fields**:

```json
{
  "ok": true,
  "ticket": "<one-time-ticket>",
  "proxyUrl": "http://127.0.0.1:<port>/proxy/<ticket>",
  "proxySecret": "<high-entropy-bearer-token>",
  "usageId": "<usage-record-id-or-null>",
  "nativeGemini4": true,
  "nativeGemini4Models": ["gemini-4-neon", "gemini-4-hydrogen", "gemini-4-carbon", "gemini-4-argon", "gemini-4-argon-cyber-permissive"],
  "vertexMultiRegions": ["us", "eu"],
  "nativeGeminiApiVersion": "v1beta"
}
```

- **Multi-region capability check (`vertexMultiRegions`)**: Frontends and `window.STVertexPayGo.prepareTicket()` inspect `prepared.vertexMultiRegions` when preparing an official (`!reverse_proxy`) Vertex `us` or `eu` request. If talking to an older `protocolVersion: 3` server that predates `vertexMultiRegions`, the client fails closed before forwarding (`MULTI_REGION_SERVER_UPGRADE_REQUIRED`) instead of letting the old server connect to non-existent `{us|eu}-aiplatform.googleapis.com`.

**Cancellation & abort semantics**:

- The frontend merges its 30-second internal timeout with the caller's `AbortSignal` (`AbortSignal.any` or fallback listener bridge).
- When the user cancels generation (external `signal.abort()`), `serverClient.prepare` immediately aborts the underlying `fetch` and rethrows the raw `AbortError` (never wrapped as `TIMEOUT`). The request hook suppresses error toasts and logs `request.prepare_aborted` at `info` level.
- On the server side, if `request.aborted` triggers before the response is sent, the reserved ticket slot is immediately released and no orphan `pending` usage record is written.

### 2.3 `GET /api/plugins/vertex-paygo/usage`

Reads per-user usage records scoped strictly to the authenticated host user and `chatId`.

Two mutually exclusive query modes are supported:

1. **Paginated chat history**:
   ```text
   GET /api/plugins/vertex-paygo/usage?chatId=<chatId>&limit=200&cursor=<opaque>
   ```
   Returns `{ ok: true, records, truncated, nextCursor? }`.
2. **Direct batch lookup by `usageId`** (`O(k)` index lookup):
   ```text
   GET /api/plugins/vertex-paygo/usage?chatId=<chatId>&ids=<id1>,<id2>,...
   ```
   - Accepts comma-separated `ids` or repeated `ids` query parameters, deduplicated in first-seen order.
   - Maximum **50 IDs** per request; each ID must match `/^[A-Za-z0-9._:-]{1,128}$/u`. Empty, malformed, or oversized lists return `400 INVALID_USAGE_IDS`.
   - Cannot be combined with `cursor` or `limit` (`400 INVALID_USAGE_PAGE`).
   - Recovers stale `pending` records from prior server runs before lookup and returns only records belonging to the authenticated user **and** matching `chatId` (`{ ok: true, records, truncated: false }`).
   - Frontend `readUsage(chatId, { ids, signal })` automatically chunks lists larger than 50 IDs and filters client-side if talking to an older backend that ignores `ids`.

---

## 3. Native Gemini 4 Envelopes & Cross-Route Behavior

Requests targeting supported Gemini 4 models on `vertexai` or `makersuite` are routed through `/api/plugins/vertex-paygo/native-gemini/generate`.

### 3.1 Parameter Normalization & Non-Streaming Fields

- `reasoning_effort` values `"off"` and `"none"` are mapped to Gemini thinking level `"LOW"` (matching `"min"` / `"minimal"` / `"low"`).
- OpenAI-style `tool.function.strict` is stripped from function declarations before forwarding to Google's native API.
- Non-streaming responses preserve existing native fields (`candidates`, `usageMetadata`, `responseContent`, `nativeGeminiSignature`) and additionally populate:
  - `choices[0].finish_reason`: normalized to `'stop' | 'length' | 'tool_calls' | 'content_filter' | null`.
  - Top-level `usage`: `{ prompt_tokens, completion_tokens, total_tokens }` when `usageMetadata` is present.

### 3.2 Signature Envelopes

To preserve Google Gemini 4 tool call IDs and multi-part `thoughtSignature` metadata through SillyTavern's chat history format, the native Gemini 4 route wraps opaque base64url JSON envelopes with versioned prefixes:

1. **Tool call envelope** (`st-vertex-paygo-tool:v1:`):
   - Stored in `part.thoughtSignature` on `functionCall` parts.
   - Payload format: `st-vertex-paygo-tool:v1:<base64url(JSON)>` where JSON is:
     ```json
     { "id": "<functionCall.id>", "signature": "<optional original thoughtSignature>" }
     ```
2. **Text parts envelope** (`st-vertex-paygo-text:v1:`):
   - Stored in `extra.reasoning_signature` (and returned as `nativeGeminiSignature` on non-streaming responses; bounded to 32 MiB JSON).
   - Payload format: `st-vertex-paygo-text:v1:<base64url(JSON)>` where JSON is:
     ```json
     {
       "parts": [{ "text": "...", "thoughtSignature": "..." }],
       "text": "<exact concatenation of parts[].text>"
     }
     ```

### 3.3 Cross-Route Compatibility Behavior

- The `st-vertex-paygo-tool:v1:` and `st-vertex-paygo-text:v1:` prefixes are **internal to the PayGo native Gemini 4 compatibility route**.
- When a user switches the same chat back to a standard (non-native-Gemini-4) route or another model/provider, historical messages may still contain these prefixed strings in `extra.reasoning_signature` or tool metadata:
  - The native Gemini 4 route validates the exact prefix, structure, and text match (`parts.map(p => p.text).join('') === text`); edited messages or mismatched formats are safely ignored rather than replayed with stale signatures.
  - Non-PayGo routes and third-party extensions **must not** forward `st-vertex-paygo-tool:v1:` or `st-vertex-paygo-text:v1:` strings verbatim as raw upstream `thoughtSignature` values. If your extension rewrites or replays chat history across routes, detect and omit those prefixed envelopes whenever the target route is not PayGo Native Gemini 4.

---

## 4. Streaming Error Boundaries

For streaming requests (`stream: true`) on `/api/plugins/vertex-paygo/native-gemini/generate`, the server delays committing HTTP `200 OK` + `Content-Type: text/event-stream` headers until the first actual SSE frame is ready to be written:

1. **Before response headers are sent (`response.headersSent === false`)**:
   - Validation failures, upstream non-2xx HTTP responses, immediate upstream `{ "error": ... }` first frames, or streams that terminate with zero visible output and no emitted frames return a **non-2xx HTTP status** (e.g., `400`, `502`) with a JSON error body:
     ```json
     {
       "error": { "code": "GEMINI4_OUTPUT_BUDGET_EXHAUSTED", "message": "...", "details": { "reason": "MAX_TOKENS" } },
       "code": "GEMINI4_OUTPUT_BUDGET_EXHAUSTED",
       "message": "..."
     }
     ```
   - Because the response fails before `HTTP 200` SSE starts, SillyTavern / Luker aborts cleanly without leaving an empty assistant message behind.
2. **After response headers are sent (`response.headersSent === true`)**:
   - Once at least one SSE frame (for example, a `thought: true` reasoning chunk or partial assistant text) has been flushed, HTTP `200 text/event-stream` is already committed.
   - Any subsequent upstream error or empty-visible-output termination is emitted as a terminal SSE error event before closing the stream:
     ```text
     data: {"error":{"code":"GEMINI4_OUTPUT_BUDGET_EXHAUSTED","message":"...","details":{"reason":"MAX_TOKENS"}}}

     ```
   - **Frontend / extension guidance**: Clients consuming SSE must check both `!response.ok` JSON errors and in-stream `data: {"error": ...}` frames. If a stream terminates with an SSE error frame after producing only reasoning (`thought`) frames and no visible reply text, discard or clean up the empty placeholder message instead of persisting a blank turn.

---

## 5. Frontend Public Collaboration API (`window.STVertexPayGo`, `v1`)

After initialization, the frontend extension exposes a frozen collaboration object on `window.STVertexPayGo` (in both SillyTavern/Luker `server` mode and TauriTavern `tauri` mode) and dispatches a `CustomEvent`:

```js
window.addEventListener('st-vertex-paygo:ready', (event) => {
    // event.detail => { apiVersion: 1, mode: 'server' | 'tauri' }
    const paygo = window.STVertexPayGo;
});
```

### 5.1 Security & Isolation Guarantees

- **Zero credential leakage on passive observers**: `inspectRoute()` and `onPrepare()` **never** expose `proxySecret`, `proxyUrl`, `ticket`, `proxy_password`, or `originalProxyPassword`.
- **Caller-scoped tickets**: Only active callers invoking `prepareTicket()` receive the single-use `ticket`, `proxyUrl`, and `proxySecret` they explicitly requested.
- **Background task tier isolation**: Unmarked `type: "extension_internal"` requests (such as background tasks) default to `tier: "standard"` (`background: true`) rather than inheriting the user's active chat `flex` or `priority` UI selection, unless explicitly tagged via `extensions['vertex-paygo']`.

### 5.2 API Reference (`apiVersion: 1`)

| Member | Signature / Value | Description |
| :--- | :--- | :--- |
| `apiVersion` | `1` | Frozen public API contract version. |
| `clientVersion` | `string` | Frontend extension version. |
| `protocolVersion` | `3` | Client-server wire protocol version. |
| `getStatus()` | `() => Readonly<{ ready, apiVersion, mode, clientVersion, protocolVersion, state }>` | Returns current readiness, runtime mode (`'server' \| 'tauri'`), versions, and normalized UI state `{ version, tier, paygoOnly }`. |
| `inspectRoute(generateData)` | `(data?) => Readonly<{ isGoogleSource, requiresPlugin, isNativeGemini4, source, model, tier, paygoOnly, originalReverseProxy, originalBaseUrl, usageChatId }>` | Pure read-only route inspector. Safely unwraps PayGo's internal failure sink without exposing any credentials or requiring access to private request keys. |
| `onPrepare(listener)` | `(fn) => unsubscribe` | Subscribes to redacted preparation events `{ usageId, usageChatId, source, model, tier, paygoOnly, stream, nativeGemini4, nativeGeminiApiVersion, background }`. Returns an unsubscribe function. |
| `prepareTicket(generateData, options?)` | `async (data, { signal?, state?, chatId?, background = true }?) => Readonly<{ ticket, proxyUrl, proxySecret, usageId, usageChatId, nativeGemini4, nativeGeminiApiVersion, tier, paygoOnly, price }>` | **Server mode only** (throws `code: 'UNSUPPORTED_MODE'` in Tauri mode). Validates state/model/region/authMode against active policy (including `MULTI_REGION_REQUIRES_FULL_AUTH` and `MULTI_REGION_SERVER_UPGRADE_REQUIRED` for `us` / `eu`), requests a single-use ticket (honoring `signal`), emits a redacted `onPrepare` event, and returns ticket details to the caller. |
| `attachMessageUsage(options)` | `({ chatId, messageIndex, swipeId?, requests }) => boolean` | Idempotently merges one or more `{ id, model?, source?, tier?, stream?, price?, durationMs?, firstTokenMs?, interrupted? }` usage requests onto an assistant message swipe and schedules targeted `?ids=` cost reconciliation. |
| `readUsage(chatId, options?)` | `async (chatId, { ids?, signal? }?) => { ok, records, truncated, nextCursor? }` | Read-only query against the server usage ledger (or local Tauri store in `tauri` mode). Supports targeted `{ ids }` lookup. |

### 5.3 Example: Multi-Turn Tool Relay Extension

```js
async function runMultiTurnToolLoop(baseGenerateData, { chatId, messageIndex, swipeId, signal }) {
    const paygo = window.STVertexPayGo;
    if (!paygo?.getStatus().ready) return null;

    const route = paygo.inspectRoute(baseGenerateData);
    if (!route.requiresPlugin || paygo.getStatus().mode !== 'server') {
        return null;
    }

    const collectedRequests = [];

    for (let turn = 0; turn < 3; turn += 1) {
        const turnData = { ...baseGenerateData, stream: true };
        const startedAt = Date.now();

        // Each round gets its own single-use loopback ticket & usageId.
        const prepared = await paygo.prepareTicket(turnData, {
            signal,
            chatId,
            background: true,
        });

        // Forward to the loopback proxy or native Gemini 4 route using prepared.proxyUrl / prepared.proxySecret ...
        const endpoint = prepared.nativeGemini4
            ? '/api/plugins/vertex-paygo/native-gemini/generate'
            : '/api/backends/chat-completions/generate';

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal,
            body: JSON.stringify({
                ...turnData,
                reverse_proxy: prepared.proxyUrl,
                proxy_password: prepared.proxySecret,
                ...(prepared.nativeGemini4 && prepared.nativeGeminiApiVersion
                    ? { native_gemini_api_version: prepared.nativeGeminiApiVersion }
                    : {}),
            }),
        });

        if (!response.ok) {
            throw new Error(`Generation failed with HTTP ${response.status}`);
        }
        // Consume stream / handle tool calls ...

        if (prepared.usageId) {
            collectedRequests.push({
                id: prepared.usageId,
                model: route.model,
                source: route.source,
                tier: prepared.tier,
                stream: true,
                price: prepared.price,
                durationMs: Date.now() - startedAt,
            });
        }
    }

    // Merge all round usageIds into the assistant message's single cost badge.
    paygo.attachMessageUsage({
        chatId,
        messageIndex,
        swipeId,
        requests: collectedRequests,
    });

    // Optional: directly fetch reconciled usage records by exact IDs.
    return paygo.readUsage(chatId, {
        ids: collectedRequests.map((r) => r.id),
        signal,
    });
}
```
