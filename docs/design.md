# Visual design: the garden

Direction: **botanical field guide**. Warm paper, ink-line procedural plants, a muted palette, calm
motion. Every encoding comes from the registry in `packages/core/src/encodings.ts`, and the legend
is generated from it. Colors live in `packages/core/src/palette.ts`.

## Color system (validated)

Validated on 2026-10-07 with the dataviz skill's `validate_palette.js` against the paper surface
`#f6f1e7`. Rule followed: run the validator, don't eyeball.

| Role | Values | Validator result |
|---|---|---|
| Foliage = median cost/run (ordinal, 5 bins) | `#7fb383 #5c9b66 #3d7f4e #25633b #124628` | `--ordinal`: **all pass** (monotone L, step gaps ≥ 0.06, light end 2.15:1, hue spread 8°) |
| Bed edging = model family (fable, opus, sonnet, haiku) | `#8a3fa0 #eb6834 #2a78d6 #1baf7a` | `--pairs all`: **all pass** (worst CVD ΔE 8.9, worst normal-vision ΔE 16.3). Contrast WARN for opus/haiku edging (2.8 / 2.5:1), so every bed shows its model as a **direct text label** |
| "Other" model | `#9a978d` neutral | Folded to neutral per rule (no 5th hue) |

Rejected along the way (recorded so nobody re-tries them):
- A lighter cheap-end foliage `#9cc79a` failed the 2:1 light-end floor (1.69:1).
- Earthy soil tones as the categorical channel failed the chroma floor (they read as gray), and two
  pairs fell below the normal-vision floor. → The soil stays neutral, and model family moved to the edging.
- Adding ochre next to terracotta failed the normal-vision floor (ΔE 12.1). Blue next to violet failed too
  (ΔE 12.0).

Status colors (`good / warning / serious / critical`) are reserved for state: flooding/dry loops and
playbook gates. They always come with an icon and a label. Bloom uses one fixed petal color, because
bloom encodes success by **count and openness**, not hue.

## Non-color cues (identity is never color alone)

- Cost: foliage lightness **plus** the value in tooltips and the table view, and a hatched pattern when unpriced.
- Model family: edging color **plus** the bed label (`opus · xhigh`).
- Loop state: water animation, plus an overflow shape (flooding) or cracked dashes (dry), plus an icon and label.
- Staleness: desaturation **plus** brown dry tips **plus** the "last run" line in the tooltip.
- Every view has a table toggle (`T`) with the same numbers, and the legend is one key away (`L`).

## Motion

Ambient sway is decorative and labeled "ambient, no meaning" in the legend. `prefers-reduced-motion`
disables sway, bee flight, and water flow animation; state stays readable from static shapes.
