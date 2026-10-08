# shop-api

Storefront API. Node 22, TypeScript, Fastify.

## Commands
- `pnpm test` runs vitest. `pnpm lint` must pass before committing.
- Run the relevant tests before saying something is done, and paste the failing assertion if they fail.

## References
- API conventions: @docs/api.md
- Release checklist: @docs/missing-release.md
- Import chain for the depth limit: @docs/chain1.md
- Architecture diagram: @docs/diagram.png
- The SDK is @anthropic-ai/sdk (a package, not an import).
- Inline code is not an import: `@docs/not-an-import.md`.

<!-- @docs/commented-out.md is inside a comment -->

```sh
# fenced code is not an import either
cat @docs/fenced.md
```

## Memory
- Testing feedback lives in memory/feedback_testing.md; read it before touching tests.
- Old notes were in memory/old_notes.md.
- The schema is documented in docs/schema.md.
- Do not edit PLAN.md (a bare generic name, never flagged).

Planted for the redaction proof: {{PLANTED}}
