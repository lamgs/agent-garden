# Verified external facts

Each entry says what was verified, where, and how. Anything not listed here is an assumption, and
parsers must treat it as one: tolerant parsing, plus a census in `garden inspect`.

Legend: **[observed]** = seen on a real file in this repo's dev container. **[docs]** = stated in
official docs (URL given). **[npm]** = `npm view` on the date shown. **[ran]** = executed locally.
**[bin]** = read in the installed Claude Code binary. Secondary-source tags ([SDK], [CL], [COM], [ND],
[web]) are defined in the sections that use them. The official docs sites were blocked by this
container's network policy for the whole build, so no entry carries a plain **[docs]** tag.

Status at M8 (2026-10-08): entries marked *superseded* below were early hypotheses that later
observation replaced; they are kept so the history of each claim stays readable.

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
| typescript | 7.0.2 (native port). *Resolved at M1:* typescript-eslint 8.71 supports `<6.1`, so the repo pins `~6.0.3` |
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
error records, user interrupts. *Partly superseded (M2):* hook executions were then observed as
`system` lines with `subtype: "stop_hook_summary"` (next section), and `attachment.type =
"instructions"` was observed in K. Compaction, API error, and interrupt records are still not
observed on real data as of M8; the parser and live layer handle them from the hypothesized shapes
below and from synthetic fixtures.

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

## Additional transcript facts [observed, CC v2.1.293, 2026-10-07, M2 real-data ingest]

- **Subagent transcripts carry stream-start usage only.** In every subagent file observed (5 files),
  every assistant line has `stop_reason: null` and `output_tokens` of 2–43, for a total of 130–335
  output tokens against 80K–105K characters of visible text and tool input. Input and cache numbers
  look right. The main transcript reports real values (`stop_reason` `tool_use`/`end_turn`, output
  up to 19K per message). → The parser keeps recorded step tokens, sets a lower-bound run estimate
  (visible chars ÷ 4), and marks the run `tokenQuality: 'output_estimated'`. The UI must label any
  cost that includes such runs.
- The parent learns a subagent finished through a `queued_command` attachment containing a
  `<task-notification>` with `<usage><subagent_tokens>N</subagent_tokens><tool_uses>…</tool_uses>
  <duration_ms>…</duration_ms></usage>`. The meaning of `subagent_tokens` is unverified, so it is not
  used for cost.
- Subagent files contain their own harness attachments (`skill_listing`, `deferred_tools_delta`,
  `mcp_instructions_delta`). A subagent's observed harness is its own.
- Harness attachments arrive after the prompt line of a turn, so the observed harness is snapshotted
  at the run's first assistant line.
- New sidecar `agent-<id>.prefix.json` (`state.toolNames`, `model`, `systemHash`), ignored. Meta files
  may also carry `worktreePath`, `spawnedWithWorktree`, `worktreeBranch`.
- `system` line with `subtype: "stop_hook_summary"` (`hookCount`, `hookInfos[].command`,
  `preventedContinuation`) → parsed as a `hook` step (command text dropped).
- More attachment types: `silent_turn_reminder`, `task_reminder`, `command_permissions`,
  `queued_command`, `edited_text_file`, `deferred_tools_record`.
- Subagents spawned with worktree isolation run with `cwd` = `<repo>/.claude/worktrees/<name>`. → These
  fold into the repository's bed (`canonicalProjectRoot`), including after the worktree is deleted.

## Live tailing [ran + observed, CC v2.1.293, 2026-10-08, this container]

- [ran] `fs.watch(~/.claude/projects, {recursive: true})` works on Node 22.22.0 / Linux here and fires
  for appends to transcripts and subagent files. `garden live:probe` while this session's subagents
  were working: 18 events in 25 s, latency from the line's `timestamp` to the emitted event p50 20 ms,
  p90 70 ms, max 92 ms (includes CC's own 30–70 ms write lag). Polling only (`--no-watch`, 250 ms):
  8 events, p50 190 ms, p90/max 279 ms. Both are within the 1 s target.
- [observed] Whole-history census through the live parser (3,273 lines, 23 MB, 9 files): 0 malformed
  lines; one unknown shape, `attachment.type=instructions` (9 lines, counted and skipped). *Superseded (K):*
  `instructions` is now a known attachment (load evidence, paths only). Seeding from
  a 256 KB tail produces one `tool_result without tool_use in the tailed range` (the call was before the
  seed window), counted, not thrown.
- [observed] `stop_reason` is repeated on every line of a main-thread message (also on its `thinking`
  line), so `turn_end` is emitted once per `message.id`. Subagent lines keep `stop_reason: null`.
- [observed] Background `Agent` calls: the parent's `tool_result` has `toolUseResult.status:
  "async_launched"`, `isAsync: true`; completion arrives as a `queued_command` attachment whose prompt is
  a `<task-notification>` with `<tool-use-id>` (= the spawn's `tool_use.id`) and `<status>`.
  Sidecar `agent-<id>.meta.json` keys here: `agentType`, `worktreePath`, `spawnedWithWorktree`,
  `worktreeBranch`, `description`, `toolUseId`, `spawnDepth`, `requestShape`, `requestNonInteractive`.
- [observed] `tool_result` lines carry `permissionDecision: {decision, source, reasonType}` (seen
  `accept` / `config` / `rule|classifier|mode`; docs/research/live-signals.md). Only short enum-like values
  are kept by the live layer.
- [observed] Session registry `~/.claude/sessions/<pid>.json` keys: `pid, sessionId, cwd, startedAt,
  procStart, version, peerProtocol, peerFeatures, kind, entrypoint, pidDomain, messagingSocketPath, name,
  nameSource, nameSince, updatedAt, status, statusUpdatedAt` (`status: idle`, `kind: interactive`; the pid
  is alive from this process's view). The live layer reads only `<digits>.json`, only `pid, sessionId,
  status, waitingFor`, and never opens the sibling `*.key` file. `waitingFor` values were not observable
  here (this container auto-approves), so registry-based permission detection is untested on real data.

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
  raising retention (it does, under "Your own data").
- Subagent transcripts: separate `subagents/agent-<agentId>.jsonl` + `.meta.json` [COM; matches observed].
  The `SubagentStop` hook input has `agent_id`, `agent_transcript_path`, `agent_type` [SDK].
- Compaction: a `system` record with `subtype: "compact_boundary"` [COM, cited in a v2.1.237 bug
  report]. `isCompactSummary` / `compactMetadata` [COM only]. Official format [ND]. → Parser must
  treat these as hypotheses until a real fixture exists. *Still a hypothesis at M8:* no real
  compaction was observed; the transcript parser, replay, and live layer all use this shape, and
  the demo generator writes it.
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

## Knowledge sources: CLAUDE.md chain, imports, rules, auto memory (K, verified 2026-10-08)

Official docs are blocked by the network policy here. Facts below come from the installed
**Claude Code 2.1.293 binary** (`strings /opt/claude-code/bin/claude`, minified JS; function names
are minifier output) **[bin]**, this container's real transcript **[observed]**, and web search
excerpts of code.claude.com/docs/en/memory and third-party guides **[web]**. Confidence:
**high** = read in the loader code, **medium** = read in strings/prompt text or one source,
**low** = inferred. Fixture: `fixtures/knowledge/` (synthetic, every shape below).

Load chain at session start (always loaded), in order [bin, high]:
1. Managed: `<managed>/CLAUDE.md` and `<managed>/.claude/rules/**/*.md`. `<managed>` =
   `/etc/claude-code` (Linux), `/Library/Application Support/ClaudeCode` (macOS),
   `C:\Program Files\ClaudeCode` (Windows). Policy settings can also inject `claudeMd` text (not a file).
2. User: `~/.claude/CLAUDE.md` and `~/.claude/rules/**/*.md`.
3. Project, for every directory from the filesystem root down to the cwd: `CLAUDE.md`,
   `.claude/CLAUDE.md`, `.claude/rules/**/*.md` (type Project), and `CLAUDE.local.md` (type Local,
   only when the local settings source is enabled, the default). In a worktree nested inside its
   main repo, directories between the main repo root and the worktree root are skipped.
4. `--add-dir` directories: the same four files.
5. Auto memory: `MEMORY.md` of the memory folder (type AutoMem).
- Memory types in code and in the `InstructionsLoaded` hook: `User | Project | Local | Managed |
  AutoMem`; hook `load_reason`: `session_start | nested_traversal | path_glob_match | include |
  compact` [bin, high].
- `AGENTS.md`: setting `instructionFiles`, default `claude-md-or-agents-md` = "a project with no
  CLAUDE.md of its own gets its AGENTS.md files instead"; also `claude-md-and-agents-md`,
  `claude-md`, `managed-only` [bin strings, medium].
- `claudeMdExcludes` (picomatch globs on absolute paths) and `CLAUDE_CODE_DISABLE_CLAUDE_MDS`
  remove files from the chain [bin, medium; not modeled].
- Files are skipped when not regular or larger than 4 MiB (`bH=4194304`) [bin, medium: the
  constant name is shared, the 4 MiB value sits next to the skip message].
- Recommended size (warning only, behind a flag): per file max(40,000, 5% of the context window ×
  4 chars) characters; total max(120,000, per-file) characters; Claude Code estimates 4 chars/token
  (3 for some models) [bin, high]. Official guidance: under 200 lines per CLAUDE.md [web, medium].

On demand [bin, high]:
- Subdirectory `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` / `.claude/rules` of a
  directory the agent works in (e.g. a Read below the cwd) load as a `nested_memory` attachment.
- Rules with `paths:` frontmatter (string or YAML list; a trailing `/**` is dropped; all-`**`
  means unconditional) load when a touched file matches (picomatch). Malformed frontmatter → the
  rule loads unconditionally [web, medium].

`@path` imports [bin, high]:
- Pattern `(?:^|\s)@((?:[^\s\\]|\\ )+)`; `#fragment` stripped; `\ ` = escaped space. Accepted when the
  target starts with `./`, `~/`, `/` (not `/` alone) or `[a-zA-Z0-9._-]`, and not `@`.
- Markdown is lexed first: matches inside code blocks and code spans are ignored; HTML comments
  are stripped. Relative paths resolve against the importing file's directory; `~/` = home.
- Depth: files at depth ≥ 5 are not loaded (`BJn=5`; root file depth 0, so 4 hops) [bin, high;
  the web says "max depth 4 hops", consistent]. Cycles are cut by a processed-paths set.
- Non-text extensions are skipped ("Skipping non-text file in @include").
- Imports outside the working directory from project/local files load only when
  `hasClaudeMdExternalIncludesApproved` (per project in `~/.claude.json`) is true; user-file imports
  outside are allowed in the CLI [bin, high]. Imported files load with their importer.
- Agent Garden: the demo ingest passes `--knowledge-boundary .garden-demo` (and an empty
  `--managed-dir`) so the ancestor walk stops at the demo folder. Without it, the repository's own
  CLAUDE.md (an ancestor of `.garden-demo/projects/*`) was counted as an always-loaded source of
  every demo bed (found at M8). Real ingests walk to the filesystem root, as Claude Code does (ours).
- Agent Garden: targets that do not look like files (no `./ ~/ /` prefix and no extension, e.g.
  `@anthropic-ai/sdk`) are not reported as dangling (ours).

Auto memory [bin, high unless noted]:
- Folder: `autoMemoryDirectory` setting (user/local/policy; ignored in project settings; `~/`
  expanded), else `<config home>/projects/<slug(canonical working-copy root)>/memory/`; slug = the
  transcript slug (every non-alphanumeric → `-`) [medium for the canonical-root detail].
  `CLAUDE_CODE_REMOTE_MEMORY_DIR` overrides the config home in remote sessions.
- Index `MEMORY.md` is always loaded: trimmed, cut at **200 lines** (`X0=200`), then at the last
  newline before **25,000 bytes** (`bne=25000`). The loader appends "MEMORY.md is N lines … Only
  part of it was loaded …" when cut. Prompt text: "`MEMORY.md` is an index, not a memory — each
  entry should be one line, under ~150 characters: `- [Title](file.md) — one-line hook`".
- Topic files: `*.md` in the folder with frontmatter `name`, `description`, `type` (`user |
  feedback | project | reference`); recalled when relevant (up to 5 per turn as a
  `relevant_memories` attachment, first 4,096 bytes / 200 lines each: `Sne=4096`, `LTe=200`) or
  read with Read. The memory scan lists the index first, then files by mtime, cap 200.
- "its MEMORY.md is not read" when an agent-memory entry "leads out of the working copy or through a
  dangling link" or "could not be resolved" [bin strings, medium: agent-scoped memory].

Skills and agents [bin, high]: the skill listing (name + description) is in every session; each
description is capped at 1,536 chars (`skillListingMaxDescChars`) and the listing at 1% of the
context window (`skillListingBudgetFraction`); `SKILL.md` over 128 KB is skipped. The body loads on
invocation. Agent definitions: the Agent tool lists name + description; the body is the
subagent's prompt.

How transcripts show loading:
- `attachment.type = "instructions"`: `{files: [{path, type, content}], removed?, changed?,
  reason?}`, `reason` ∈ session_start, compaction, policy_refresh, directory_added, settings_sync,
  … **[observed]** in this container's transcript (one file, `type: "Project"`) and [bin] schema.
  The parser keeps `path` only; `content` is dropped.
- `attachment.type = "nested_memory"`: `{path, content: {path, type, content, globs?}, displayPath}`
  [bin, high; not observed]. Rendered as "Loaded <path>".
- `attachment.type = "relevant_memories"`: `{memories: [{path, content, mtimeMs, header, limit?}]}`
  [bin, high; not observed].
- Read tool calls on memory/instruction files: `tool_use.input.file_path` [observed].
- `system` subtype `instruction_size_warning` is "never stored in the transcript" [bin].
