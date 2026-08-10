---
name: Paper-Trading Fixture Visibility Latency
description: API-Tennis publishes some tournament fixtures late (8-15 min before start). LOCK_GRACE_MINUTES was extended from 15 to 25 to catch them; the effective lock window is now 5 min before match start.
---

## The rule

`LOCK_GRACE_MINUTES` in `artifacts/api-server/src/services/evaluation/paperTrading.ts` must satisfy:

```
paperTradeLeadMinutes - LOCK_GRACE_MINUTES > 0
```

This keeps the lock deadline strictly before match start. The current value (25, with lead=30) gives a 5-min buffer.

**Why:** API-Tennis does not guarantee fixture availability 30+ minutes before start. For some tournaments, fixtures first appear in the feed 8–15 minutes before their scheduled time. With the old `LOCK_GRACE_MINUTES=15`, any fixture appearing within 15 min of start was already past the lock deadline and immediately classified "missed." Extending to 25 catches fixtures appearing as late as 5 min before start while the hard `now >= scheduledStartAt` guard prevents any post-start locks.

**How to apply:** If `paperTradeLeadMinutes` is changed in `prediction_settings`, recalibrate LOCK_GRACE_MINUTES. The invariant above must hold. If fixture visibility latency is observed to exceed `LOCK_GRACE_MINUTES`, extend further (the hard guard prevents over-locking).

## Secondary factor: cycle duration bottleneck

The effective inter-cycle interval is 37–50 minutes (15-min timer + 22–26 min ledger grading duration + in-flight guard). This means a 25-minute grace window only covers about half the possible arrival times for a late fixture. Decoupling ledger grading from the fixture-lock loop would reduce missed predictions further.
