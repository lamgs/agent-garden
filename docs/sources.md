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

## Official documentation

See the "Docs check" section below.
