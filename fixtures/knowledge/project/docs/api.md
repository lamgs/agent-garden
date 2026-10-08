# API conventions

- Routes are versioned under `/v1`. Errors use `{ error: { code, message, fields? } }`.
- List endpoints paginate with `limit` (max 200) and an opaque `cursor`.
