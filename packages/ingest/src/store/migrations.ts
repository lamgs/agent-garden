/**
 * SQLite schema. Mirrors packages/core/src/schema.ts; documented in docs/schema.md.
 * Append new migrations; never edit a shipped one.
 */
export const MIGRATIONS: readonly string[] = [
  /* 1 */ `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sources (
    id TEXT PRIMARY KEY, adapter TEXT NOT NULL, root TEXT NOT NULL, adapter_version TEXT NOT NULL
  );

  CREATE TABLE agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('main','subagent')),
    definition_json TEXT, first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
  );

  CREATE TABLE harness_families (id TEXT PRIMARY KEY, name TEXT NOT NULL, project_root TEXT NOT NULL);

  CREATE TABLE harness_versions (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES harness_families(id),
    valid_from TEXT NOT NULL, valid_to TEXT,
    provenance TEXT NOT NULL CHECK (provenance IN ('git','observed','snapshot')),
    bundle_json TEXT NOT NULL, commit_json TEXT, diff_json TEXT
  );
  CREATE INDEX harness_versions_family ON harness_versions(family_id, valid_from);

  CREATE TABLE skills (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, dir_name TEXT NOT NULL, scope TEXT NOT NULL,
    path TEXT NOT NULL, description TEXT, content_hash TEXT NOT NULL
  );

  CREATE TABLE playbooks (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, steps_json TEXT NOT NULL);

  CREATE TABLE loops (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, tier TEXT NOT NULL, provenance TEXT NOT NULL,
    trigger_kind TEXT NOT NULL, trigger_detail TEXT NOT NULL, expected_interval_sec REAL,
    targets_json TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id),
    family_id TEXT NOT NULL REFERENCES harness_families(id), path TEXT NOT NULL,
    cli_version TEXT, entrypoint TEXT, git_branch TEXT, started_at TEXT NOT NULL, ended_at TEXT NOT NULL
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
    agent_id TEXT NOT NULL REFERENCES agents(id), family_id TEXT NOT NULL REFERENCES harness_families(id),
    harness_version_id TEXT NOT NULL REFERENCES harness_versions(id),
    parent_run_id TEXT, parent_step_id TEXT, loop_id TEXT,
    started_at TEXT NOT NULL, ended_at TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK (trigger IN ('human','automated','subagent')),
    task_preview TEXT NOT NULL, models_json TEXT NOT NULL,
    tok_input INTEGER NOT NULL, tok_output INTEGER NOT NULL, tok_cache_read INTEGER NOT NULL,
    tok_cache_write_5m INTEGER NOT NULL, tok_cache_write_1h INTEGER NOT NULL, tok_thinking INTEGER,
    step_count INTEGER NOT NULL, tool_call_count INTEGER NOT NULL, error_count INTEGER NOT NULL,
    compaction_count INTEGER NOT NULL, peak_context_tokens INTEGER NOT NULL
  );
  CREATE INDEX runs_agent_family ON runs(agent_id, family_id, started_at);
  CREATE INDEX runs_session ON runs(session_id, started_at);
  CREATE INDEX runs_parent ON runs(parent_run_id);

  CREATE TABLE steps (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), seq INTEGER NOT NULL, at TEXT NOT NULL,
    kind TEXT NOT NULL, loop_tier TEXT NOT NULL, preview TEXT,
    tool_name TEXT, tool_call_id TEXT, tool_category TEXT, mcp_server TEXT, skill_id TEXT, tool_is_error INTEGER,
    api_message_id TEXT, tokens_json TEXT, context_tokens INTEGER,
    error_kind TEXT, error_message TEXT, compaction_json TEXT, child_run_id TEXT
  );
  CREATE INDEX steps_run ON steps(run_id, seq);

  CREATE TABLE outcomes (
    run_id TEXT PRIMARY KEY REFERENCES runs(id), label TEXT NOT NULL, score REAL,
    heuristic_version TEXT NOT NULL, signals_json TEXT NOT NULL
  );

  -- Kept separate so re-ingestion never overwrites a human label.
  CREATE TABLE manual_labels (
    run_id TEXT PRIMARY KEY, label TEXT NOT NULL, note TEXT, at TEXT NOT NULL
  );

  CREATE TABLE ingest_files (
    path TEXT PRIMARY KEY, adapter TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL,
    byte_offset INTEGER NOT NULL, ingested_at TEXT NOT NULL
  );
  `,
  /* 2 */ `
  ALTER TABLE runs ADD COLUMN token_quality TEXT NOT NULL DEFAULT 'reported'
    CHECK (token_quality IN ('reported','output_estimated'));
  `,
  /* 3: knowledge map (K). Paths, sizes, hashes, derived facts only; never file content. */ `
  CREATE TABLE knowledge_scans (
    family_id TEXT PRIMARY KEY REFERENCES harness_families(id), scanned_at TEXT NOT NULL,
    memory_dir TEXT, external_imports_approved INTEGER NOT NULL, warnings_json TEXT NOT NULL
  );

  CREATE TABLE knowledge_sources (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES harness_families(id),
    kind TEXT NOT NULL, scope TEXT NOT NULL, path TEXT NOT NULL, display_path TEXT NOT NULL, name TEXT,
    bytes INTEGER NOT NULL, lines INTEGER NOT NULL, always_bytes INTEGER NOT NULL,
    load_mode TEXT NOT NULL CHECK (load_mode IN ('always','on_demand','path_scoped','not_loaded')),
    load_note TEXT, import_depth INTEGER, globs_json TEXT, memory_type TEXT,
    content_hash TEXT NOT NULL, passage_hashes_json TEXT NOT NULL,
    last_changed_at TEXT, changed_via TEXT
  );
  CREATE INDEX knowledge_sources_family ON knowledge_sources(family_id);

  CREATE TABLE knowledge_edges (
    id TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES harness_families(id),
    from_id TEXT NOT NULL, to_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('import','index_link','mention')),
    target TEXT NOT NULL, resolved INTEGER NOT NULL, beyond_cap INTEGER NOT NULL, reason TEXT
  );
  CREATE INDEX knowledge_edges_family ON knowledge_edges(family_id);

  CREATE TABLE knowledge_snapshots (
    family_id TEXT NOT NULL REFERENCES harness_families(id), at TEXT NOT NULL,
    commit_sha TEXT NOT NULL DEFAULT '', provenance TEXT NOT NULL CHECK (provenance IN ('git','current')),
    layers_json TEXT NOT NULL,
    PRIMARY KEY (family_id, at, commit_sha)
  );

  CREATE TABLE knowledge_usage (
    session_id TEXT NOT NULL REFERENCES sessions(id), family_id TEXT NOT NULL,
    path TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('session_load','nested_load','memory_recall','read')),
    count INTEGER NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
    PRIMARY KEY (session_id, path, kind)
  );
  CREATE INDEX knowledge_usage_family ON knowledge_usage(family_id, path);
  `,
];
