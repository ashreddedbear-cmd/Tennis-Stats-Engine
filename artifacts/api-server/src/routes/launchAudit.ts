import { Router, type IRouter } from 'express';
import { requireAdmin } from '../lib/adminAuth';
import { auditAdminWrite } from '../middlewares/auditLog';
import { adminLimiter } from '../middlewares/rateLimiter';
import { getLaunchAuditSummary, getLiveStatus, runLaunchAudit, testProviderByName } from '../services/launchAudit';

const router: IRouter = Router();

/**
 * GET /launch-audit/summary
 * Fast lightweight snapshot: DB row counts, provider status, security checks.
 * Does NOT run the full 15-category audit. Used by the 60-second auto-refresh.
 */
router.get('/launch-audit/summary', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Launch audit summary failed' });
  }
});

/**
 * POST /launch-audit/run
 * Runs the full 15-category audit, writes docs/launch-audit/latest-launch-audit.md,
 * and persists a history entry. Takes a few seconds but is synchronous (short enough to not need async job).
 */
router.post('/launch-audit/run', requireAdmin, adminLimiter, auditAdminWrite(), async (_req, res): Promise<void> => {
  try {
    const summary = await runLaunchAudit();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Launch audit run failed' });
  }
});

/**
 * GET /launch-audit/live
 * Returns only provider health cards — no DB queries or findings.
 * The fastest possible read for the live monitoring auto-refresh.
 */
router.get('/launch-audit/live', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const live = await getLiveStatus();
    res.json(live);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Live status failed' });
  }
});

/**
 * POST /launch-audit/providers/test
 * Returns status cards for all configured providers (read-only, no quota-consuming calls).
 */
router.post('/launch-audit/providers/test', requireAdmin, adminLimiter, auditAdminWrite(), async (_req, res): Promise<void> => {
  try {
    const live = await getLiveStatus();
    res.json({ providers: live.providers, testedAt: live.generatedAt });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provider test failed' });
  }
});

/**
 * POST /launch-audit/providers/:name/test
 * Returns status for a single named provider.
 * :name is matched case-insensitively against provider names.
 */
router.post('/launch-audit/providers/:name/test', requireAdmin, adminLimiter, auditAdminWrite(), (req, res): void => {
  try {
    const card = testProviderByName(String(req.params.name));
    if (!card) {
      res.status(404).json({ error: `Provider "${String(req.params.name)}" not found` });
      return;
    }
    res.json({ provider: card, testedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provider test failed' });
  }
});

export default router;
