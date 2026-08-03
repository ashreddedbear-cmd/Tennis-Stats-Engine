---
name: Recommendation v2 type propagation
description: When adding new recommendation tier values, three separate generated files must be updated and a route-alias name mismatch will crash the entire router.
---

## The rule
New recommendation string values must be added in three places or the live app breaks:

1. **`lib/api-zod/src/generated/api.ts`** — 6 occurrences of `zod.enum([...])` on the `recommendation` field. A missing value here causes "Database query failed: invalid_enum_value" errors on every prediction write that returns the new tier.

2. **`lib/api-client-react/src/generated/api.schemas.ts`** — The `Recommendation` const object. Missing values cause TypeScript type narrowing errors in switch/ternary comparisons in History.tsx and PredictionResult.tsx. These are compile-time only (Vite transpiles without checking) but are worth fixing.

3. **`artifacts/tennis-predictor/src/App.tsx`** — Lazy-import alias must match the component name used in the route. If the lazy import creates `LiveAuditsPage` (line 29) but the route uses `LaunchAuditPage` (line 259), the router crashes with a ReferenceError that takes down the entire app.

**Why:** Orval codegen produces both a zod schema file (api-zod) and a TypeScript type file (api-client-react/api.schemas.ts) separately. Neither auto-updates when the engine adds a new enum value — they must be manually patched until the next full codegen run.

**How to apply:** When shipping a new recommendation tier, run `grep -rn "STRONG_RECOMMENDATION" lib/` to find all three files and patch them. Also check App.tsx for lazy-import/route-component name mismatches before deploying.
