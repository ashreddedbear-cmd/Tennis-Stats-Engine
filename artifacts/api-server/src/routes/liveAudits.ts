import { Router, type IRouter, type Request, type Response } from 'express';
import { isAdminSessionCookieValid } from '../lib/adminAuth';
import { getLaunchAuditSummary, getLiveStatus, runLaunchAudit } from '../services/launchAudit';

/**
 * Live Audits API Routes (Part 1 Backend)
 * Provides comprehensive production-readiness monitoring interface with role-based access control
 * and comprehensive operational sections/tabs.
 */

const router: IRouter = Router();

// ─── Role & Permission Types ───────────────────────────────────────────────

type LiveAuditsRole = 'owner' | 'admin' | 'developer' | 'user' | 'unknown';

interface LiveAuditsPermissions {
  canRunAudits: boolean;
  canViewLogs: boolean;
  canRetrySafeJobs: boolean;
  canManageAlerts: boolean;
  canRunPerformanceTests: boolean;
  canRunDestructiveRollback: boolean;
  canRunDestructiveRepairs: boolean;
}

interface LiveAuditsAccess {
  authenticated: boolean;
  role: LiveAuditsRole;
  canAccessLiveAudits: boolean;
  permissions: LiveAuditsPermissions;
}

// ─── Permission Matrix ─────────────────────────────────────────────────────

const DefaultPermissions: Record<LiveAuditsRole, LiveAuditsPermissions> = {
  owner: {
    canRunAudits: true,
    canViewLogs: true,
    canRetrySafeJobs: true,
    canManageAlerts: true,
    canRunPerformanceTests: true,
    canRunDestructiveRollback: true,
    canRunDestructiveRepairs: true,
  },
  admin: {
    canRunAudits: true,
    canViewLogs: true,
    canRetrySafeJobs: true,
    canManageAlerts: true,
    canRunPerformanceTests: true,
    canRunDestructiveRollback: false,
    canRunDestructiveRepairs: false,
  },
  developer: {
    canRunAudits: true,
    canViewLogs: true,
    canRetrySafeJobs: true,
    canManageAlerts: false,
    canRunPerformanceTests: false,
    canRunDestructiveRollback: false,
    canRunDestructiveRepairs: false,
  },
  user: {
    canRunAudits: false,
    canViewLogs: false,
    canRetrySafeJobs: false,
    canManageAlerts: false,
    canRunPerformanceTests: false,
    canRunDestructiveRollback: false,
    canRunDestructiveRepairs: false,
  },
  unknown: {
    canRunAudits: false,
    canViewLogs: false,
    canRetrySafeJobs: false,
    canManageAlerts: false,
    canRunPerformanceTests: false,
    canRunDestructiveRollback: false,
    canRunDestructiveRepairs: false,
  },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeRole(input: string | undefined, authenticated: boolean): LiveAuditsRole {
  if (!authenticated) return 'user';
  if (!input) return 'owner';

  const normalized = input.trim().toLowerCase();
  if (normalized === 'owner') return 'owner';
  if (normalized === 'admin') return 'admin';
  if (normalized === 'developer' || normalized === 'dev') return 'developer';
  if (normalized === 'user') return 'user';
  return 'unknown';
}

function mergePermissions(role: LiveAuditsRole, partial: Partial<LiveAuditsPermissions> | undefined): LiveAuditsPermissions {
  return {
    ...DefaultPermissions[role],
    ...partial,
  };
}

/**
 * Extract user authentication from request.
 * Current system: single-owner model with admin session cookie.
 * If admin session is valid, assign 'owner' role.
 * Extensible for future multi-user/OAuth systems via x-user-role header.
 */
function extractUserAuth(req: Request): { authenticated: boolean; role: string | undefined } {
  const authenticated = isAdminSessionCookieValid(req.signedCookies);
  // For now, authenticated users are always owners in this single-owner system
  // Future enhancement: read from header, database, or OAuth provider
  const role = authenticated ? 'owner' : undefined;
  return { authenticated, role };
}

/**
 * Middleware: Check Live Audits access and populate req.liveAuditsAccess
 */
async function checkLiveAuditsAccess(req: Request, res: Response, next: any): Promise<void> {
  const { authenticated, role } = extractUserAuth(req);
  const normalizedRole = normalizeRole(role, authenticated);
  const permissions = mergePermissions(normalizedRole, undefined);

  (req as any).liveAuditsAccess = {
    authenticated,
    role: normalizedRole,
    canAccessLiveAudits: normalizedRole === 'owner' || normalizedRole === 'admin' || normalizedRole === 'developer',
    permissions,
  } as LiveAuditsAccess;

  next();
}

/**
 * Guard: Require Live Audits access
 */
function requireLiveAuditsAccess(req: Request, res: Response, next: any): void {
  const access = (req as any).liveAuditsAccess as LiveAuditsAccess | undefined;
  if (!access?.canAccessLiveAudits) {
    res.status(403).json({ error: 'Live Audits access restricted to Owner/Admin/Developer roles' });
    return;
  }
  next();
}

/**
 * Guard: Require specific permission
 */
function requirePermission(permission: keyof LiveAuditsPermissions) {
  return (req: Request, res: Response, next: any): void => {
    const access = (req as any).liveAuditsAccess as LiveAuditsAccess | undefined;
    if (!access?.permissions[permission]) {
      res.status(403).json({ error: `Permission denied: ${permission}` });
      return;
    }
    next();
  };
}

// ─── Apply Access Check Middleware to All Live Audits Routes ────────────────

router.use(checkLiveAuditsAccess);

// ─── Routes ────────────────────────────────────────────────────────────────

/**
 * GET /api/live-audits/access
 * Returns current user's access level and permissions
 */
router.get('/api/live-audits/access', (_req: Request, res: Response): void => {
  const access = (_req as any).liveAuditsAccess as LiveAuditsAccess;
  res.json(access);
});

/**
 * GET /api/live-audits/overview
 * Fast lightweight snapshot: findings summary, status, recent history.
 * Does NOT run the full audit.
 */
router.get('/api/live-audits/overview', requireLiveAuditsAccess, async (_req: Request, res: Response): Promise<void> => {
  try {
    const summary = await getLaunchAuditSummary();
    res.json({
      status: 'success',
      data: summary,
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: error instanceof Error ? error.message : 'Failed to fetch overview',
    });
  }
});

/**
 * POST /api/live-audits/run
 * Runs the full audit. Requires canRunAudits permission.
 */
router.post(
  '/api/live-audits/run',
  requireLiveAuditsAccess,
  requirePermission('canRunAudits'),
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const summary = await runLaunchAudit();
      res.json({
        status: 'success',
        data: summary,
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to run audit',
      });
    }
  },
);

/**
 * GET /api/live-audits/section/:sectionId
 * Returns data for a specific operational section/tab.
 * Sections: overview, system-health, testing-center, deployment-checks,
 *           monitoring-alerts, performance, error-logs, rollback-recovery,
 *           database-health, prediction-engine-health, api-status,
 *           background-jobs, audit-history
 */
router.get(
  '/api/live-audits/section/:sectionId',
  requireLiveAuditsAccess,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { sectionId } = req.params;

      // For now, return appropriate data based on section type
      // This will be expanded with actual section-specific data
      const summary = await getLaunchAuditSummary();
      const liveStatus = await getLiveStatus();

      type SectionData = {
        status: string;
        data?: Record<string, any>;
        message?: string;
      };

      const sectionData: SectionData = (() => {
        switch (sectionId) {
          case 'overview':
            return { status: 'success', data: summary };
          case 'system-health':
            return {
              status: 'success',
              data: {
                providers: liveStatus.providers,
                findings: summary.findings,
              },
            };
          case 'testing-center':
            return {
              status: 'success',
              data: {
                testSuites: [
                  { name: 'Full Audit', id: 'full', status: 'Ready', lastRun: summary.generatedAt },
                  { name: 'E2E Tests', id: 'e2e', status: 'Ready', lastRun: null },
                  { name: 'Integrity Check', id: 'integrity', status: 'Ready', lastRun: null },
                  { name: 'Regression Suite', id: 'regression', status: 'Ready', lastRun: null },
                  { name: 'Type Check', id: 'typecheck', status: 'Ready', lastRun: null },
                  { name: 'Build Check', id: 'build', status: 'Ready', lastRun: null },
                  { name: 'Mobile Layout', id: 'mobile', status: 'Ready', lastRun: null },
                ],
              },
            };
          case 'deployment-checks':
            return {
              status: 'success',
              data: {
                preDeploymentAudit: summary,
                currentVersion: '1.0.0',
                commitHash: 'HEAD',
              },
            };
          case 'monitoring-alerts':
            return {
              status: 'success',
              data: {
                alerts: [],
                rules: [],
              },
            };
          case 'performance':
            return {
              status: 'success',
              data: {
                metrics: [],
                thresholds: {},
              },
            };
          case 'error-logs':
            return {
              status: 'success',
              data: {
                logs: summary.findings.filter((f) => f.status === 'Fail' || f.status === 'Warning'),
              },
            };
          case 'rollback-recovery':
            return {
              status: 'success',
              data: {
                restorePoints: [],
                recoveryChecks: [],
              },
            };
          case 'database-health':
            return {
              status: 'success',
              data: {
                findings: summary.findings.filter((f) => f.category === 'database'),
              },
            };
          case 'prediction-engine-health':
            return {
              status: 'success',
              data: {
                findings: summary.findings.filter((f) => f.category === 'prediction'),
              },
            };
          case 'api-status':
            return {
              status: 'success',
              data: {
                providers: liveStatus.providers,
                findings: summary.findings.filter((f) => f.category === 'backend' || f.category === 'api'),
              },
            };
          case 'background-jobs':
            return {
              status: 'success',
              data: {
                jobs: [],
                schedule: {},
              },
            };
          case 'audit-history':
            return {
              status: 'success',
              data: {
                history: summary.history || [],
              },
            };
          default:
            return {
              status: 'error',
              message: `Unknown section: ${sectionId}`,
            };
        }
      })();

      res.json(sectionData);
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to fetch section',
      });
    }
  },
);

/**
 * POST /api/live-audits/action
 * Perform operational actions (e.g., retry job, create restore point, etc.)
 * Request body: { action: string, params?: Record<string, any> }
 */
router.post(
  '/api/live-audits/action',
  requireLiveAuditsAccess,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const { action, params } = req.body;
      const access = (req as any).liveAuditsAccess as LiveAuditsAccess;

      // Permission guards for destructive actions
      const destructiveActions = ['rollback-to-previous', 'repair-database'];
      if (destructiveActions.includes(action) && !access.permissions.canRunDestructiveRollback) {
        res.status(403).json({ error: `Action "${action}" requires destructive permission` });
        return;
      }

      // TODO: Implement actual action handling
      // For now, return success
      res.json({
        status: 'success',
        message: `Action "${action}" executed`,
        result: {},
      });
    } catch (error) {
      res.status(500).json({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to execute action',
      });
    }
  },
);

export default router;
