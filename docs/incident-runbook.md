# Tennis Matrix AI — Incident Runbook

> **Keep this open during any incident.** Update the postmortem section after resolution.

---

## 1. Triage Checklist (first 5 minutes)

| Step | Action |
|------|--------|
| 1 | Check **[System Health](https://your-domain/api/health/system)** — any circuit breakers OPEN? |
| 2 | Check **[API Health](https://your-domain/api/healthz)** — is the server up? |
| 3 | Check workflow logs in Replit (`artifacts/api-server: API Server`) for uncaught errors |
| 4 | Check browser console on the frontend for JS errors |
| 5 | Check deployment logs for recent deploy failures |

---

## 2. Circuit Breaker States

`GET /api/health/system` returns:
```json
{
  "status": "ok | degraded",
  "circuitBreakers": [
    { "name": "api-tennis", "state": "CLOSED | OPEN | HALF_OPEN", "recentFailures": 0 }
  ]
}
```

**OPEN** = provider is being bypassed (too many recent failures). Wait `openDurationMs` (30–60s) — it auto-transitions to HALF_OPEN and probes. If the provider is genuinely down, predictions will degrade gracefully (data unavailable, not crash).

---

## 3. Common Failure Scenarios

### API-Tennis provider down
- **Symptom:** Predictions return with warnings about missing player data; `api-tennis` circuit OPEN
- **Action:** Wait for auto-recovery (30s open → half-open probe). If sustained, check API-Tennis status at https://api.api-tennis.com
- **Fallback:** Engine continues with available data; quality warnings are surfaced in the prediction result

### Walk-forward in progress — API server slow
- **Symptom:** `/api/predictions` requests time out; high memory in system health endpoint
- **Action:** `GET /api/evaluation/walk-forward/status` — check if `state: "running"`. Do NOT restart the API server; it will kill the in-flight job.
- **Recovery:** Wait for `state: "done"`, then restart is safe

### Rate limit triggered (429 from our API)
- **Symptom:** Users see "Too many requests" errors
- **Action:** Review rate-limit tiers in `src/middlewares/rateLimiter.ts`. Adjust `limit` or `windowMs` as needed and redeploy.
- **Legitimate abuse?** Check pino logs for the abusing IP: `grep '"ip":"X.X.X.X"' /var/log/app.log`

### Database connection failure
- **Symptom:** All routes returning 500; logs show `ECONNREFUSED` to DB
- **Action:** Check Replit DB status. Verify `DATABASE_URL` secret is set and correct.
- **Recovery:** Restart workflow after confirming DB is accessible

### Stripe webhook not firing (subscriptions broken)
- **Symptom:** Users can't upgrade; payments succeed in Stripe but entitlements don't update
- **Action:** Check Stripe webhook logs in Stripe dashboard. Verify `STRIPE_WEBHOOK_SECRET` is current and the webhook endpoint is reachable.
- **Quick test:** `GET /api/payments/subscription-status` with a paid user — if it returns `tier: "free"` despite payment, webhook delivery is the issue.

### Calibration model stale / predictions feel wrong
- **Symptom:** Accuracy dashboard shows poor calibration; predictions systematically over/under-confident
- **Action:**
  1. Check when calibration was last run: `GET /api/evaluation/calibration-refit/job-runs`
  2. Trigger a refit (admin only): `POST /api/evaluation/calibration-refit`
  3. Monitor job completion at `GET /api/evaluation/walk-forward/status`
- **Note:** Walk-forward takes 8–12+ minutes. Do not restart the API server during it.

---

## 4. Rollback Procedure

### Code rollback
1. Open **Checkpoints** in Replit (top toolbar)
2. Identify the last stable checkpoint before the bad deploy
3. Click **Restore** — this rolls back all file changes
4. Verify with `GET /api/healthz` after workflow restarts

### Database rollback
> **Warning:** Database changes may not be reversible. Always back up first.
1. Connect to the production DB via Replit DB tool
2. Run read-only queries to verify data integrity before making changes
3. If schema migration caused the issue, manually apply the reverse migration SQL

---

## 5. Environment Variables & Secrets

All secrets are managed via Replit Secrets. Never hardcode or log them. Key secrets:

| Secret | Purpose |
|--------|---------|
| `ADMIN_ACCESS_KEY` | Admin panel login |
| `SESSION_SECRET` | Signed cookie encryption |
| `API_TENNIS_KEY` | API-Tennis provider |
| `ODDS_API_IO_KEY` | Odds-API.io provider |
| `THE_ODDS_API_KEY` | The Odds API provider |
| `STRIPE_SECRET_KEY` | Stripe payments |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook verification |
| `CLERK_SECRET_KEY` | Clerk auth backend |

**Key rotation:** After rotating any key in the external provider's dashboard, update it in Replit Secrets and restart the affected workflow.

---

## 6. Monitoring Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/healthz` | Basic liveness check |
| `GET /api/health/system` | Circuit breakers + memory + uptime |
| `GET /api/auth/status` | Admin session check |
| `GET /api/evaluation/walk-forward/status` | Walk-forward job state |
| `GET /api/evaluation/calibration-refit/job-runs` | Calibration history |
| `POST /api/launch-audit/run` *(admin)* | Full 15-category audit |

---

## 7. Launch Checklist

Before going live / after a major deploy:

- [ ] `GET /api/healthz` returns `{"status":"ok"}`
- [ ] `GET /api/health/system` shows all circuit breakers CLOSED
- [ ] Run smoke tests: `BASE_URL=https://your-domain bash artifacts/api-server/scripts/smoke-test.sh`
- [ ] Run prediction engine invariant tests: `pnpm --filter @workspace/api-server exec tsx --test $(find src/services/predictionEngine -name '*.test.ts')`
- [ ] Verify admin login works at `/admin/login`
- [ ] Verify Stripe checkout flow (test mode) completes successfully
- [ ] Verify Clerk sign-in / sign-up flows work
- [ ] Spot-check 2–3 predictions end-to-end through the UI
- [ ] Confirm `POST /api/launch-audit/run` returns no CRITICAL findings
- [ ] Check that rate limit headers appear on `/api/predictions`

---

## 8. Postmortem Template

```
## Incident: [Brief Title]
**Date:** YYYY-MM-DD  
**Duration:** X hours Y minutes  
**Impact:** [Who was affected and how]

### Timeline
- HH:MM — First alert / user report
- HH:MM — Root cause identified
- HH:MM — Fix deployed
- HH:MM — Confirmed resolved

### Root Cause
[What broke and why]

### Fix
[What was changed to resolve it]

### Action Items
- [ ] [Preventive measure 1]
- [ ] [Preventive measure 2]
```
