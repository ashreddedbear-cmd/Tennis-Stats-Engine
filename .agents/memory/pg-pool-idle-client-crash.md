---
name: pg-pool idle-client crash
description: Bare pg Pool with no error listener crashes the process when Postgres terminates an idle connection — fix and location.
---

## Rule
Always attach `pool.on("error", handler)` immediately after creating a `new Pool()`. Without it, PostgreSQL forcibly terminating an idle connection (admin command, DB maintenance, connection timeout) causes pg-pool to emit an `'error'` event on the idle client — Node.js treats an EventEmitter 'error' with no listener as an uncaught exception and exits the process with code 1.

**Why:** `pg-pool` v3 does not suppress these error events internally. The crash manifests as `node:events: throw er; // Unhandled 'error' event` followed by `error: terminating connection due to administrator command` in the logs. This is the root cause of the production crash loops observed on 2026-07-29.

**How to apply:** In `lib/db/src/index.ts`, after `export const pool = new Pool(...)`:
```typescript
pool.on("error", (err) => {
  console.error("[db] Idle client error — pg-pool will replace it automatically.", err.message);
});
```
pg-pool removes the dead client and opens a fresh one on the next query — no manual recovery needed. The handler just needs to exist so the event is consumed.

## Location
`lib/db/src/index.ts` — fix was applied 2026-07-29. Both `dist/index.mjs` and all job entry-point bundles pick it up on the next build.
