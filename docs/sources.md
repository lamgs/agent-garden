# Verified external facts

Each entry says what was verified, where, and how. Anything not listed here is an assumption, and
parsers must treat it as one: tolerant parsing, plus a census in `garden inspect`.

Legend: **[observed]** = seen on a real file in this repo's dev container. **[docs]** = stated in
official docs (URL given). **[npm]** = `npm view` on the date shown. **[ran]** = executed locally.

## Environment (2026-10-07, cloud dev container)

- [ran] Node v22.22.0, npm 10.9.4, pnpm 10.28.0.
- [ran] `node:sqlite` works on Node 22.22.0 without a flag. `DatabaseSync` reports SQLite 3.50.4 and
  emits an `ExperimentalWarning` at load. The minimum Node version for flagless use is not verified here.
- [ran] Playwright 1.56.1 is installed globally, and Chromium build `chromium-1194` is preinstalled at
  `/opt/pw-browsers`. `@playwright/test` is pinned to 1.56.x to match.
- [ran] The network policy denies `huggingface.co` (proxy answers 403 to CONNECT) and allows
  `registry.npmjs.org`. Consequence: neural-embedding model downloads can't be tested in this container.

## Library versions [npm, 2026-10-07]

| Package | Latest |
|---|---|
| pixi.js | 8.22.0 |
| @pixi/react | 8.0.5 (not planned for the hot path) |
| react | 19.3.0 |
| vite | 8.3.3 |
| vitest | 5.0.3 |
| typescript | 7.0.2 (native port; typescript-eslint support to be checked at M1) |
| zod | 4.6.5 |
| hono / @hono/node-server | 4.13.13 / 2.1.3 |
| yaml | 2.9.1 |
| tsx | 4.23.15 |
| @huggingface/transformers | 4.3.1 (opt-in embeddings only) |
| @playwright/test | 1.64.0 latest; pinned to 1.56.x (see above) |
| better-sqlite3 | 13.0.3 (not chosen; native build) |

## Claude Code session transcripts [observed, CC v2.1.293, entrypoint `remote_desktop`]

Path: `~/.claude/projects/<project-dir>/<sessionId>.jsonl`, where `<project-dir>` is the cwd with `/`
replaced by `-` (observed: `/home/user/agent-garden` → `-home-user-agent-garden`).

Line `type` values seen: `user`, `assistant`, `attachment`, `queue-operation` (`operation`:
`enqueue`/`dequeue`), `last-prompt`, `atis-latch`.

Common fields on `user` / `assistant` / `attachment` lines: `uuid`, `parentUuid`, `sessionId`,
`timestamp` (ISO), `cwd`, `gitBranch`, `version`, `entrypoint`, `isSidechain`, `userType`.

`assistant` lines:
- `message` has `id`, `model` (e.g. `claude-opus-5-5`), `role`, `content[]`, `stop_reason`, `usage`, and more.
- **One API response is written as multiple lines, one content block per line** (`apiBlockIndex`),
  and every line repeats the identical full `usage`. Observed 1–3 lines per `message.id` in one
  session. Token totals must be deduped by `message.id` (or `requestId`).
- `usage` fields: `input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, `cache_creation.{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}`,
  `output_tokens_details.thinking_tokens`, `server_tool_use.{web_search_requests, web_fetch_requests}`,
  `service_tier`, `speed`, `iterations[]`.
- Line-level extras: `requestId`, `effort` (e.g. `xhigh`), `perTurnEffort`, `thinkingDurationMs`.
- Content block types seen: `thinking`, `text`, `tool_use` (`id`, `name`, `input`, `caller`).

`user` lines:
- Human prompt: `message.content` is a string; `origin: {kind: "human"}`, `promptSource` (e.g. `sdk`),
  `permissionMode` (e.g. `auto`).
- Tool result: `message.content` is a list of `tool_result` blocks (`tool_use_id`, `is_error`,
  `content` as string or list) plus a top-level `toolUseResult`. For Bash it is
  `{stdout, stderr, interrupted, isImage, noOutputExpected}`; on error it can be a plain string.
  `sourceToolAssistantUUID` links back to the assistant line.

`attachment` lines (`attachment.type` values seen): `environment`, `model`, `deferred_tools_delta`
(`addedNames` = tool names incl. `mcp__<server>__<tool>`), `agent_listing_delta` (`addedTypes`,
`builtInTypes`), `mcp_instructions_delta` (`addedNames` = MCP server names), `skill_listing`
(`names`, `skillCount`), `auto_mode`, `total_tokens_reminder`, `session_context`, `date`,
`credential_org`, `remote_session_change`, `prompt_snapshot`, `deferred_tools_record`.
→ The harness the model saw (tools, skills, subagent types, MCP servers) can be fingerprinted from
these attachments.

Not observed yet (no instance in available files): compaction records, hook-execution records, API
error records, user interrupts.

## Subagent transcripts [observed, CC v2.1.293]

- Parent `assistant` line: `tool_use` with `name: "Agent"`, `input: {description, prompt,
  subagent_type, run_in_background}`.
- Parent `user` line `toolUseResult` for that call: `{agentId, status, isAsync, description, prompt,
  resolvedModel, outputFile, canContinueAgent, canReadOutputFile}`.
- The subagent transcript is a **separate file**:
  `~/.claude/projects/<project-dir>/<sessionId>/subagents/agent-<agentId>.jsonl`. Every line has
  `agentId` and `isSidechain: true`. The first line is a `user` line with `parentUuid: null`.
  Assistant lines add `attributionAgent`.
- Sidecar `agent-<agentId>.meta.json`: `{agentType, description, toolUseId, spawnDepth,
  requestShape, requestNonInteractive}`. `toolUseId` joins it to the parent `tool_use.id`.
- `~/.claude/projects/<project-dir>/<sessionId>/` also contained `ccr-tip.json` (cloud-specific, ignored).

## Skills [observed]

- `~/.claude/skills/<dir>/SKILL.md` with YAML frontmatter `name`, `description`.
- **The directory name can differ from the frontmatter `name`**: `session-start-hook/SKILL.md` declares
  `name: startup-hook-skill`, and the skill listing shows `session-start-hook (startup-hook-skill)`.
- Skill dirs can contain `references/`, `scripts/`, `assets/`, `agents/`, `LICENSE.txt`.
- Plugin-provided skills are namespaced in listings as `<plugin>:<skill>` (e.g. `anthropic-skills:pdf`).

## Settings / hooks [observed]

- No `~/.claude/settings.json` exists in this container. A `launcher-settings.json` with top-level
  keys `$schema`, `hooks`, `permissions` is present (cloud-specific).
- `~/.claude.json` top-level keys observed include `projects`, `oauthAccount`, `userID`, and caches.
  No `mcpServers` key was present here. **This file contains account identifiers. Ingestion reads only
  `mcpServers` / `projects.*.mcpServers` names and never stores other keys.**

## Pricing [bundled claude-api skill reference, cached 2026-10-06]

Used for `packages/core/src/pricing.ts` (`PRICING_VERSION = '2026-10-06'`). Source: the Claude API
reference bundled with Claude Code 2.1.293 ("Current Models" table and `shared/prompt-caching.md`).
I did not fetch the live pricing page, so re-verify before quoting dollar figures externally.

| Model | Input $/MTok | Output $/MTok | Cache read $/MTok | Context |
|---|---|---|---|---|
| claude-fable-5-1 | 10 | 50 | 0.25 | 1M |
| claude-fable-5 | 10 | 50 | 1.00 | 1M |
| claude-opus-5-5 | 4 | 20 | 0.20 | 1M |
| claude-opus-5 / 4-8 / 4-7 / 4-6 | 5 | 25 | 0.50 (0.1×) | 1M |
| claude-sonnet-5-5 / sonnet-5 | 2 | 10 | 0.20 | 1M |
| claude-sonnet-4-6 | 3 | 15 | 0.30 (0.1×) | 1M |
| claude-haiku-5-5 | 0.10 (≤100K prompt; 0.50 beyond) | 0.50 (2.50 beyond) | 0.01 (0.1×, assumed) | 1M |
| claude-haiku-4-5 | 1 | 5 | 0.10 (0.1×) | 200K |

- Cache writes: **1.25× input for the 5-minute TTL, 2× for the 1-hour TTL** (prompt-caching reference).
- Cache reads are "~0.1× base input" except where stated per model (Fable 5.1 0.025×, Opus 5.5 0.05×).
  Rows marked (0.1×) apply that default.
- Not modeled yet: Haiku 5.5 long-prompt tier, fast mode ($8/$40 on Opus 5.5), batch discounts.
  Users can override via `garden.yaml`.

## Official documentation (docs check, 2026-10-07)

A research subagent tried to verify the Claude Code file formats against the official docs. **The
official docs sites (code.claude.com, docs.claude.com, platform.claude.com) were blocked by this
container's network policy**, so its findings come from secondary sources. The tags give confidence:
**[SDK]** Anthropic Agent SDK source (`claude-agent-sdk-python` types), **[CL]** `anthropics/claude-code`
CHANGELOG.md, **[COM]** community/third-party, **[ND]** not documented anywhere reachable. Where these
agree with **[observed]** facts above, the observation wins.

- Transcript path: `~/.claude/projects/<cwd with non-alphanumerics → '->/<sessionId>.jsonl`. The
  mapping is lossy, so always read `cwd` from the records [COM, consistent with observed].
- Retention: `cleanupPeriodDays` (default 30) deletes inactive sessions at startup. Since v2.1.89, `0` is
  a validation error [CL]. → Ingestion keeps history in `garden.db`, and the README should advise
  raising retention.
- Subagent transcripts: separate `subagents/agent-<agentId>.jsonl` + `.meta.json` [COM; matches observed].
  The `SubagentStop` hook input has `agent_id`, `agent_transcript_path`, `agent_type` [SDK].
- Compaction: a `system` record with `subtype: "compact_boundary"` [COM, cited in a v2.1.237 bug
  report]. `isCompactSummary` / `compactMetadata` [COM only]. Official format [ND]. → Parser must
  treat these as hypotheses until a real fixture exists.
- Subagent definitions: `.claude/agents/*.md` (project), `~/.claude/agents/*.md` (user), plugin
  `agents/*.md`. YAML frontmatter: `name`, `description` (required), `tools`, `disallowedTools`,
  `model` (`sonnet|opus|haiku|<id>|inherit`), `permissionMode`, `maxTurns`, `skills`, `mcpServers`,
  `hooks`, `memory`, `effort`, `background`, `isolation`, `color`, … [COM / docs search excerpts]. →
  Parse `name`, `description`, `tools`, `model` and keep other keys as opaque metadata.
- Skills: `~/.claude/skills/<name>/SKILL.md`, `.claude/skills/<name>/SKILL.md`, plugin `skills/`.
  **Canonical identifier is the frontmatter `name`** (CHANGELOG v2.1.290 fixed lookup "by the name in
  SKILL.md when their folder has a different name") [CL; matches observed name ≠ dir].
- Settings precedence (highest first): managed > command line > local (`.claude/settings.local.json`)
  > project (`.claude/settings.json`) > user (`~/.claude/settings.json`) [COM, consistent across sources].
- Hooks shape: `{"hooks": {"<Event>": [{"matcher": "Write|Edit", "hooks": [{"type": "command",
  "command": "...", "timeout": 60}]}]}}` [SDK + plugin docs]. Events include PreToolUse, PostToolUse,
  PostToolUseFailure, UserPromptSubmit, Stop, SubagentStop, SubagentStart, PreCompact, Notification,
  PermissionRequest, SessionStart, SessionEnd [SDK enum + plugin docs]. Handler types: `command`,
  `prompt` (others unverified).
- MCP: project `.mcp.json` `{"mcpServers": {name: {command, args, env}}}`. Local scope in
  `~/.claude.json` `projects["<abs path>"].mcpServers`, user scope in `~/.claude.json` top-level
  `mcpServers` [COM]. → Read server names only. `env` values are always redacted.
- Hook input common fields: `session_id`, `transcript_path`, `cwd`, `permission_mode?`,
  `hook_event_name`. Stop has `stop_hook_active` [SDK].
- Entrypoints: `sdk-py` set by the Python Agent SDK [SDK]. `cli`, `sdk-cli` (for `claude -p`) [COM].
  `remote_desktop` [observed]. `/loop` and cron markers in transcripts: [ND].
- OpenTelemetry: `CLAUDE_CODE_ENABLE_TELEMETRY=1`. Metrics such as `claude_code.token.usage`,
  `claude_code.cost.usage`, `claude_code.session.count`. Events such as `claude_code.api_request`,
  `claude_code.tool_result`. Prompt text only with `OTEL_LOG_USER_PROMPTS=1` [COM, partly from docs
  excerpts]. → Basis for a future OTel adapter.
