import { Router, type IRouter } from 'express';
import { requireAdmin } from '../lib/adminAuth';
import {
  getLaunchAuditSummary,
  getLiveStatus,
  runLaunchAudit,
  testProviderByName,
  type LaunchAuditFinding,
} from '../services/launchAudit';

const router: IRouter = Router();

function findingsFor(summary: { findings: LaunchAuditFinding[] }, matcher: RegExp): LaunchAuditFinding[] {
  return summary.findings.filter(
    (finding) => matcher.test(finding.category) || matcher.test(finding.checkName) || matcher.test(finding.relatedService),
  );
}

function notConfigured(section: string, message: string, extras: Record<string, unknown> = {}) {
  return {
    section,
    status: 'not-configured',
    message,
    ...extras,
  };
}

function manualOnly(section: string, message: string, extras: Record<string, unknown> = {}) {
  return {
    section,
    status: 'manual-only',
    message,
    ...extras,
  };
}

router.get('/live-audits/overview', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Live audits overview failed' });
  }
});

router.post('/live-audits/deployment/full-launch/run', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await runLaunchAudit();
    res.json({ ...summary, status: 'running' });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Live audits run failed' });
  }
});

router.get('/live-audits/system-health', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    const findings = findingsFor(summary, /frontend|backend|api|database|security|provider/i);
    res.json({
      section: 'system-health',
      overallStatus: summary.overallStatus,
      generatedAt: summary.generatedAt,
      findings,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'System health query failed' });
  }
});

router.post('/live-audits/system-health/retry', requireAdmin, (req, res): void => {
  res.json(manualOnly('system-health', 'Automated component retry is not configured on this environment.', { component: req.body?.component ?? null }));
});

router.get('/live-audits/testing-center', requireAdmin, (_req, res): void => {
  res.json(
    manualOnly('testing-center', 'Test orchestration is still manual on this environment.', {
      suites: ['full', 'e2e', 'integrity', 'regression', 'type-check', 'build-check', 'mobile'].map((suite) => ({
        suite,
        status: 'manual-only',
      })),
    }),
  );
});

router.post('/live-audits/testing-center/run', requireAdmin, (req, res): void => {
  res.json(manualOnly('testing-center', 'Test suites must be run manually from CI or the workspace terminal.', { suite: req.body?.suite ?? null }));
});

router.get('/live-audits/deployment-checks', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json({
      section: 'deployment-checks',
      auditId: summary.auditId ?? null,
      commit: summary.commit ?? null,
      version: summary.version ?? null,
      overallStatus: summary.overallStatus,
      lastAuditAt: summary.generatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Deployment checks query failed' });
  }
});

router.post('/live-audits/deployment-checks/pre-deploy/run', requireAdmin, (_req, res): void => {
  res.json(manualOnly('deployment-checks', 'Pre-deployment audits are run manually via the launch audit workflow.'));
});

router.post('/live-audits/deployment-checks/post-deploy-smoke/run', requireAdmin, (_req, res): void => {
  res.json(manualOnly('deployment-checks', 'Post-deployment smoke tests are not automated on this environment.'));
});

router.get('/live-audits/monitoring-alerts', requireAdmin, (_req, res): void => {
  res.json(notConfigured('monitoring-alerts', 'Alert integrations are not configured on this environment.'));
});

router.post('/live-audits/monitoring-alerts/refresh', requireAdmin, (_req, res): void => {
  res.json(manualOnly('monitoring-alerts', 'Alert configuration refresh is managed outside this API.'));
});

router.post('/live-audits/monitoring-alerts/history', requireAdmin, (_req, res): void => {
  res.json(notConfigured('monitoring-alerts', 'Alert history is not available from this environment yet.', { history: [] }));
});

router.get('/live-audits/performance', requireAdmin, (_req, res): void => {
  res.json(notConfigured('performance', 'Performance telemetry is not configured on this environment.'));
});

router.post('/live-audits/performance/run-approved-test', requireAdmin, (_req, res): void => {
  res.json(manualOnly('performance', 'Approved performance tests must be initiated manually.'));
});

router.get('/live-audits/error-logs', requireAdmin, (_req, res): void => {
  res.json(notConfigured('error-logs', 'Centralized error log search is not configured on this environment.', { entries: [] }));
});

router.post('/live-audits/error-logs/search', requireAdmin, (req, res): void => {
  res.json(notConfigured('error-logs', 'Centralized error log search is not configured on this environment.', {
    query: req.body?.query ?? '',
    page: req.body?.page ?? 1,
    entries: [],
  }));
});

router.get('/live-audits/rollback-recovery', requireAdmin, (_req, res): void => {
  res.json(
    manualOnly('rollback-recovery', 'Rollback orchestration is not configured on this environment.', {
      destructiveActionsEnabled: false,
    }),
  );
});

router.post('/live-audits/rollback-recovery/create-restore-point', requireAdmin, (_req, res): void => {
  res.json(manualOnly('rollback-recovery', 'Restore points are managed outside this API.'));
});

router.post('/live-audits/rollback-recovery/run-recovery-check', requireAdmin, (_req, res): void => {
  res.json(manualOnly('rollback-recovery', 'Recovery checks are not automated on this environment.'));
});

router.post('/live-audits/rollback-recovery/rollback', requireAdmin, (_req, res): void => {
  res.status(403).json({ error: 'Rollback is restricted and not configured on this environment' });
});

router.get('/live-audits/database-health', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json({
      section: 'database-health',
      overallStatus: summary.overallStatus,
      findings: findingsFor(summary, /database|historical|prediction|calibration/i),
      generatedAt: summary.generatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Database health query failed' });
  }
});

router.post('/live-audits/database-health/destructive-repair', requireAdmin, (_req, res): void => {
  res.status(403).json({ error: 'Destructive repairs are restricted and not configured on this environment' });
});

router.get('/live-audits/prediction-engine-health', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json({
      section: 'prediction-engine-health',
      overallStatus: summary.overallStatus,
      findings: findingsFor(summary, /prediction|calibration|engine/i),
      generatedAt: summary.generatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Prediction engine health query failed' });
  }
});

router.get('/live-audits/api-status', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const live = await getLiveStatus();
    res.json({
      section: 'api-status',
      ...live,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'API status query failed' });
  }
});

router.post('/live-audits/api-status/providers/test', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const live = await getLiveStatus();
    res.json({ providers: live.providers, testedAt: live.generatedAt });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provider test failed' });
  }
});

router.post('/live-audits/api-status/providers/:name/test', requireAdmin, (req, res): void => {
  try {
    const provider = testProviderByName(req.params.name);
    if (!provider) {
      res.status(404).json({ error: `Provider "${req.params.name}" not found` });
      return;
    }

    res.json({ provider, testedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Provider test failed' });
  }
});

router.get('/live-audits/background-jobs', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json(
      manualOnly('background-jobs', 'Background job orchestration is still manual on this environment.', {
        findings: findingsFor(summary, /job|paper trading|backfill|calibration/i),
        generatedAt: summary.generatedAt,
      }),
    );
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Background jobs query failed' });
  }
});

router.post('/live-audits/background-jobs/retry-safe-job', requireAdmin, (_req, res): void => {
  res.json(manualOnly('background-jobs', 'Safe job retries are not automated on this environment.'));
});

router.get('/live-audits/audit-history', requireAdmin, async (_req, res): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json({
      section: 'audit-history',
      history: summary.history ?? [],
      generatedAt: summary.generatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Audit history query failed' });
  }
});

export default router;