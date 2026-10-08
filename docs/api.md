# Local API

Served by `garden serve` on **127.0.0.1 only** (default port 4310). Response shapes are the view
contracts in `packages/core/src/views.ts`. Every response carries a strict Content-Security-Policy
(no remote origins, no eval).

| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | `{ ok, schemaVersion, runs, asOf }` |
| GET | `/api/legend` | Legend entries generated from the encodings registry |
| GET | `/api/garden?days=90&asOf=<ISO>` | `GardenView` |
| GET | `/api/plant/:plantId?days=` | `PlantView` (404 if the planting has no runs in the window) |
| GET | `/api/compare?left=<bedId>&right=<bedId>&days=` | `BedCompareView` |
| GET | `/api/replant?agent=<agentId>&from=<bedId>&to=<bedId>&days=` | `ReplantView` |
| GET | `/api/replay/:runId` | `ReplayView`: frames with deduped context fill and cumulative tokens/cost, child runs to depth 3 (404 for an unknown run; no window filter) |
| POST | `/api/runs/:runId/label` | `{ runId, outcome }`, body `{ label: success\|partial\|failure\|unknown\|clear, note? }` |

`days` is 1..3650 (default 90). `asOf` pins "now". The demo uses the dataset's end date.

## Guards (local-only by construction)

- **Bind address**: the listener binds `127.0.0.1`. A test asserts `server.address()`.
- **DNS rebinding**: every request whose `Host` is not `127.0.0.1`, `localhost`, or `[::1]` gets a
  403. This stops a malicious site that resolves its own domain to 127.0.0.1 from reading your garden.
- **CSRF**: non-GET requests need an `Origin` on a loopback host **and** `Content-Type:
  application/json`. Cross-site form posts and no-cors fetches cannot meet both.
- **Label notes** pass through the ingestion `Redactor` before they reach the store, the same as
  transcript text. Manual labels live in their own table and survive re-ingestion.

`garden label <runId> <label> [--note]` writes the same labels from the command line.
