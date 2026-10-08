---
paths:
  - "src/api/**/*.ts"
  - "src/routes/**"
---

# API rules

- Validate request bodies with the zod schemas in `src/schemas`. Return 422 with field errors.
