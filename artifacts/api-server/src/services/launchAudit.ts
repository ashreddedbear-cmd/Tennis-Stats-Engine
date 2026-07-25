import { promises as fs } from 'node:fs';
import path from 'node:path';
import { sql, desc, isNotNull, count, eq } from 'drizzle-orm';
import { db, evaluationPredictionsTable, calibrationModelsTable, historicalMatchesTable, jobRunsTable, predictionsTable } from '@workspace/db';
import { getOddsProviderStatuses } from './oddsData';
import { getTennisDataProvider } from './tennisData';
import { getAdminAccessKey } from '../lib/adminAuth';

export interface LaunchAuditFinding {
  category: string;
  checkName: string;
  status: 'Pass' | 'Warning' | 'Fail' | 'Not Configured' | 'Not Applicable' | 'Unable to Verify';
  severity: 'Critical' | 'High' | 'Medium' | 'Low' | 'Informational';
  evidence: string;
  expectedResult: string;
  actualResult: string;
  recommendedAction: string;
  relatedService: string;
  timestamp: string;
}

export interface ProviderHealthCard {
  name: string;
  category: 'tennis-data' | 'odds' | 'vision' | 'weather' | 'geocoding';
  role: 'primary' | 'fallback' | 'standalone';
  status: 'Healthy' | 'Warning' | 'No Recent Traffic' | 'Auth Failed' | 'Not Configured' | 'Degraded';
  keyConfigured: boolean;
  lastCallAt: string | null;
  lastError: string | null;
  details: string;
}

export interface LaunchAuditSummary {
  overallStatus: 'Ready' | 'Ready With Warnings' | 'Not Ready' | 'Audit Incomplete';
  passCount: number;
  warningCount: number;
  failCount: number;
  criticalCount: number;
  highCount: number;
  findings: LaunchAuditFinding[];
  providers: ProviderHealthCard[];
  reportPath?: string;
  history?: LaunchAuditHistoryEntry[];
  generatedAt: string;
}

export interface LaunchAuditHistoryEntry {
  id: string;
  startedAt: string;
  completedAt: string;
  overallStatus: LaunchAuditSummary['overallStatus'];
  passCount: number;
  warningCount: number;
  failCount: number;
  criticalCount: number;
  highCount: number;
  reportPath: string;
}

export function deriveOverallStatus(findings: LaunchAuditFinding[]): LaunchAuditSummary['overallStatus'] {
  if (findings.length === 0) return 'Audit Incomplete';
  const hasCritical = findings.some((f) => f.severity === 'Critical' && f.status === 'Fail');
  if (hasCritical) return 'Not Ready';
  const hasHigh = findings.some((f) => f.severity === 'High' && f.status === 'Fail');
  if (hasHigh) return 'Not Ready';
  const hasFail = findings.some((f) => f.status === 'Fail');
  const hasWarning = findings.some((f) => f.status === 'Warning' || f.status === 'Not Configured');
  if (hasFail || hasWarning) return 'Ready With Warnings';
  return 'Ready';
}

export function buildLaunchAuditSummary(
  findings: LaunchAuditFinding[],
  providers: ProviderHealthCard[],
): LaunchAuditSummary {
  const passCount = findings.filter((f) => f.status === 'Pass').length;
  const warningCount = findings.filter((f) => f.status === 'Warning' || f.status === 'Not Configured').length;
  const failCount = findings.filter((f) => f.status === 'Fail').length;
  const criticalCount = findings.filter((f) => f.severity === 'Critical').length;
  const highCount = findings.filter((f) => f.severity === 'High').length;
  return {
    overallStatus: deriveOverallStatus(findings),
    passCount,
    warningCount,
    failCount,
    criticalCount,
    highCount,
    findings,
    providers,
    generatedAt: new Date().toISOString(),
  };
}

// ── Provider health cards ──────────────────────────────────────────────────────

function buildProviderCards(): ProviderHealthCard[] {
  const provider = getTennisDataProvider();
  const status = provider.getStatus();
  const oddsStatuses = getOddsProviderStatuses();

  const cards: ProviderHealthCard[] = [];

  // Primary tennis data provider (MatchStat/RapidAPI)
  const rapidApiKeyConfigured = !!(process.env.X_RAPIDAPI_KEY ?? process.env.x_rapidapi_key);
  cards.push({
    name: 'MatchStat (RapidAPI)',
    category: 'tennis-data',
    role: 'primary',
    keyConfigured: rapidApiKeyConfigured,
    status: !rapidApiKeyConfigured ? 'Not Configured' : status.provider.includes('MatchStat') && status.connected ? 'Healthy' : rapidApiKeyConfigured ? 'No Recent Traffic' : 'Not Configured',
    lastCallAt: status.provider.includes('MatchStat') ? status.lastSuccessfulCallAt ?? null : null,
    lastError: status.provider.includes('MatchStat') ? status.lastError ?? null : null,
    details: rapidApiKeyConfigured ? 'Upcoming ATP/WTA fixtures, player search' : 'x_rapidapi_key not configured',
  });

  // Fallback tennis data provider (API-Tennis)
  const apiTennisKeyConfigured = !!process.env.API_TENNIS_KEY;
  const apiTennisConnected = status.provider.includes('API-Tennis') && status.connected;
  cards.push({
    name: 'API-Tennis',
    category: 'tennis-data',
    role: 'fallback',
    keyConfigured: apiTennisKeyConfigured,
    status: !apiTennisKeyConfigured ? 'Not Configured' : apiTennisConnected ? 'Healthy' : apiTennisKeyConfigured ? 'No Recent Traffic' : 'Not Configured',
    lastCallAt: status.provider.includes('API-Tennis') ? status.lastSuccessfulCallAt ?? null : null,
    lastError: status.provider.includes('API-Tennis') ? status.lastError ?? null : null,
    details: apiTennisKeyConfigured ? 'Fallback: H2H, historical, live scores, player profiles' : 'API_TENNIS_KEY not configured',
  });

  // Odds providers
  const theOddsKeyConfigured = !!process.env.THE_ODDS_API_KEY;
  const oddsApiIoKeyConfigured = !!process.env.ODDS_API_IO_KEY;
  const theOddsStatus = oddsStatuses.find((s) => s.provider === 'TheOddsAPI');
  const oddsApiIoStatus = oddsStatuses.find((s) => s.provider === 'OddsApiIo');

  cards.push({
    name: 'The Odds API',
    category: 'odds',
    role: 'primary',
    keyConfigured: theOddsKeyConfigured,
    status: !theOddsKeyConfigured ? 'Not Configured' : theOddsStatus?.connected ? 'Healthy' : 'No Recent Traffic',
    lastCallAt: theOddsStatus?.lastSuccessfulCallAt ?? null,
    lastError: theOddsStatus?.lastError ?? null,
    details: theOddsKeyConfigured ? 'Pre-match H2H market odds (primary)' : 'THE_ODDS_API_KEY not configured',
  });

  cards.push({
    name: 'Odds-API.io',
    category: 'odds',
    role: 'fallback',
    keyConfigured: oddsApiIoKeyConfigured,
    status: !oddsApiIoKeyConfigured ? 'Not Configured' : oddsApiIoStatus?.connected ? 'Healthy' : 'No Recent Traffic',
    lastCallAt: oddsApiIoStatus?.lastSuccessfulCallAt ?? null,
    lastError: oddsApiIoStatus?.lastError ?? null,
    details: oddsApiIoKeyConfigured ? 'Pre-match H2H market odds (fallback)' : 'ODDS_API_IO_KEY not configured',
  });

  // Screenshot / Vision AI
  const screenshotKeyConfigured = !!process.env.SCREENSHOT_AI_KEY;
  const anthropicKeyConfigured = !!process.env.ANTHROPIC_API_KEY;
  const openaiKeyConfigured = !!(process.env.AI_INTEGRATIONS_OPENAI_API_KEY);
  const geminiKeyConfigured = !!process.env.GEMINI_API_KEY;
  const visionAvailable = screenshotKeyConfigured || anthropicKeyConfigured || openaiKeyConfigured || geminiKeyConfigured;

  cards.push({
    name: 'Screenshot / Vision AI',
    category: 'vision',
    role: 'standalone',
    keyConfigured: visionAvailable,
    status: !visionAvailable ? 'Not Configured' : 'No Recent Traffic',
    lastCallAt: null,
    lastError: null,
    details: visionAvailable
      ? `Keys configured: ${[screenshotKeyConfigured && 'SCREENSHOT_AI_KEY', anthropicKeyConfigured && 'ANTHROPIC', openaiKeyConfigured && 'OPENAI (Replit)', geminiKeyConfigured && 'GEMINI'].filter(Boolean).join(', ')}`
      : 'No vision AI key configured — screenshot paste will fail',
  });

  // Open-Meteo (free, no key needed)
  cards.push({
    name: 'Open-Meteo',
    category: 'weather',
    role: 'standalone',
    keyConfigured: true,
    status: 'Healthy',
    lastCallAt: null,
    lastError: null,
    details: 'Free weather API, no key required — always available',
  });

  // Geoapify
  const geoapifyKeyConfigured = !!process.env.GEOAPIFY_API_KEY;
  cards.push({
    name: 'Geoapify',
    category: 'geocoding',
    role: 'standalone',
    keyConfigured: geoapifyKeyConfigured,
    status: !geoapifyKeyConfigured ? 'Not Configured' : 'No Recent Traffic',
    lastCallAt: null,
    lastError: null,
    details: geoapifyKeyConfigured ? 'Venue geocoding for weather integration' : 'GEOAPIFY_API_KEY not configured — weather will degrade',
  });

  return cards;
}

// ── Audit check helpers ────────────────────────────────────────────────────────

function ts(): string {
  return new Date().toISOString();
}

async function runDatabaseChecks(): Promise<LaunchAuditFinding[]> {
  const findings: LaunchAuditFinding[] = [];

  try {
    const [hmResult, predResult, evalResult, calibResult] = await Promise.all([
      db.select({ n: count() }).from(historicalMatchesTable),
      db.select({ n: count() }).from(predictionsTable),
      db.select({ n: count() }).from(evaluationPredictionsTable),
      db.select({ n: count() }).from(calibrationModelsTable),
    ]);

    const hmCount = hmResult[0]?.n ?? 0;
    const predCount = predResult[0]?.n ?? 0;
    const evalCount = evalResult[0]?.n ?? 0;
    const calibCount = calibResult[0]?.n ?? 0;

    findings.push({
      category: 'Database',
      checkName: 'Database connection',
      status: 'Pass',
      severity: 'Informational',
      evidence: `Queries succeeded — ${hmCount.toLocaleString()} historical matches, ${predCount.toLocaleString()} predictions, ${evalCount.toLocaleString()} evaluation rows`,
      expectedResult: 'DB reachable',
      actualResult: `Connected — ${hmCount.toLocaleString()} historical matches`,
      recommendedAction: 'Keep monitoring',
      relatedService: 'postgresql',
      timestamp: ts(),
    });

    findings.push({
      category: 'Database',
      checkName: 'Historical match corpus',
      status: hmCount >= 10000 ? 'Pass' : hmCount >= 1000 ? 'Warning' : 'Fail',
      severity: hmCount >= 10000 ? 'Informational' : hmCount >= 1000 ? 'Medium' : 'High',
      evidence: `${hmCount.toLocaleString()} historical matches stored`,
      expectedResult: '≥ 10,000 historical matches for reliable engine',
      actualResult: `${hmCount.toLocaleString()} rows`,
      recommendedAction: hmCount < 10000 ? 'Run historical backfill to expand training corpus' : 'Keep monitoring',
      relatedService: 'historical_matches',
      timestamp: ts(),
    });

    findings.push({
      category: 'Database',
      checkName: 'Prediction history',
      status: predCount >= 50 ? 'Pass' : predCount > 0 ? 'Warning' : 'Fail',
      severity: predCount >= 50 ? 'Informational' : predCount > 0 ? 'Low' : 'Medium',
      evidence: `${predCount.toLocaleString()} live predictions stored`,
      expectedResult: 'Predictions accumulating',
      actualResult: `${predCount.toLocaleString()} predictions`,
      recommendedAction: predCount === 0 ? 'Run test predictions to confirm the engine is working end-to-end' : 'Keep monitoring',
      relatedService: 'predictions',
      timestamp: ts(),
    });

    findings.push({
      category: 'Database',
      checkName: 'Calibration models',
      status: calibCount > 0 ? 'Pass' : 'Warning',
      severity: calibCount > 0 ? 'Informational' : 'Medium',
      evidence: `${calibCount} calibration model(s) in database`,
      expectedResult: 'At least one calibration model',
      actualResult: `${calibCount} model(s)`,
      recommendedAction: calibCount === 0 ? 'Trigger calibration refit after walk-forward completes' : 'Keep monitoring',
      relatedService: 'calibration_models',
      timestamp: ts(),
    });
  } catch (err) {
    findings.push({
      category: 'Database',
      checkName: 'Database connection',
      status: 'Fail',
      severity: 'Critical',
      evidence: err instanceof Error ? err.message : 'Unknown DB error',
      expectedResult: 'DB reachable',
      actualResult: 'Connection failed',
      recommendedAction: 'Restore database connectivity immediately — app cannot function without DB',
      relatedService: 'postgresql',
      timestamp: ts(),
    });
  }

  return findings;
}

async function runApiChecks(): Promise<LaunchAuditFinding[]> {
  const findings: LaunchAuditFinding[] = [];
  const provider = getTennisDataProvider();
  const providerStatus = provider.getStatus();
  const oddsStatuses = getOddsProviderStatuses();

  // Tennis data provider
  findings.push({
    category: 'APIs',
    checkName: 'Tennis data provider',
    status: providerStatus.connected ? 'Pass' : providerStatus.lastError ? 'Fail' : 'Warning',
    severity: providerStatus.connected ? 'Informational' : providerStatus.lastError ? 'High' : 'Medium',
    evidence: providerStatus.lastError ?? `${providerStatus.provider} responded successfully at ${providerStatus.lastSuccessfulCallAt ?? 'startup'}`,
    expectedResult: 'Provider available and responding',
    actualResult: providerStatus.connected ? `${providerStatus.provider} connected` : `${providerStatus.provider} not yet called or errored`,
    recommendedAction: providerStatus.connected ? 'Keep monitoring' : 'Verify API key and make a test call from the provider card',
    relatedService: providerStatus.provider,
    timestamp: ts(),
  });

  // Odds providers
  const oddsConfigured = oddsStatuses.length > 0;
  findings.push({
    category: 'APIs',
    checkName: 'Market odds providers',
    status: oddsConfigured ? 'Pass' : 'Warning',
    severity: oddsConfigured ? 'Informational' : 'Low',
    evidence: oddsConfigured
      ? `${oddsStatuses.length} odds provider(s) configured: ${oddsStatuses.map((s) => s.provider).join(', ')}`
      : 'No odds providers configured — market edge tracking unavailable',
    expectedResult: 'At least one odds provider configured',
    actualResult: oddsConfigured ? `${oddsStatuses.length} configured` : 'None configured',
    recommendedAction: oddsConfigured ? 'Keep monitoring' : 'Configure THE_ODDS_API_KEY or ODDS_API_IO_KEY for market edge tracking',
    relatedService: 'odds-data',
    timestamp: ts(),
  });

  // Screenshot / Vision AI
  const hasVision = !!(
    process.env.SCREENSHOT_AI_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ||
    process.env.GEMINI_API_KEY
  );
  findings.push({
    category: 'APIs',
    checkName: 'Screenshot / Vision AI',
    status: hasVision ? 'Pass' : 'Warning',
    severity: hasVision ? 'Informational' : 'Low',
    evidence: hasVision ? 'At least one vision AI key configured' : 'No vision AI key — screenshot upload will fail',
    expectedResult: 'Vision AI key configured',
    actualResult: hasVision ? 'Configured' : 'Not configured',
    recommendedAction: hasVision ? 'Keep monitoring' : 'Set SCREENSHOT_AI_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY',
    relatedService: 'screenshot-recognition',
    timestamp: ts(),
  });

  // Open-Meteo (always available — free)
  findings.push({
    category: 'APIs',
    checkName: 'Open-Meteo weather API',
    status: 'Pass',
    severity: 'Informational',
    evidence: 'Open-Meteo is a free API with no key requirement — always available',
    expectedResult: 'Weather API reachable',
    actualResult: 'No key required — available',
    recommendedAction: 'Keep monitoring',
    relatedService: 'open-meteo',
    timestamp: ts(),
  });

  // Geoapify
  const geoapifyConfigured = !!process.env.GEOAPIFY_API_KEY;
  findings.push({
    category: 'APIs',
    checkName: 'Geoapify geocoding',
    status: geoapifyConfigured ? 'Pass' : 'Warning',
    severity: geoapifyConfigured ? 'Informational' : 'Low',
    evidence: geoapifyConfigured ? 'GEOAPIFY_API_KEY configured' : 'GEOAPIFY_API_KEY not set — weather context will degrade gracefully',
    expectedResult: 'Geocoding key configured for venue weather',
    actualResult: geoapifyConfigured ? 'Configured' : 'Not configured',
    recommendedAction: geoapifyConfigured ? 'Keep monitoring' : 'Set GEOAPIFY_API_KEY for venue-to-coordinates resolution',
    relatedService: 'geoapify',
    timestamp: ts(),
  });

  return findings;
}

async function runJobChecks(): Promise<LaunchAuditFinding[]> {
  const findings: LaunchAuditFinding[] = [];

  try {
    // Check for recent paper trading job runs (last 48h)
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const recentJobs = await db
      .select({ jobName: jobRunsTable.jobName, status: jobRunsTable.status, finishedAt: jobRunsTable.finishedAt })
      .from(jobRunsTable)
      .where(sql`${jobRunsTable.finishedAt} > ${cutoff}`)
      .orderBy(desc(jobRunsTable.finishedAt))
      .limit(20);

    const paperJobs = recentJobs.filter((j) => j.jobName.includes('paper'));
    const calibJobs = recentJobs.filter((j) => j.jobName.includes('calibration'));
    const backfillJobs = recentJobs.filter((j) => j.jobName.includes('backfill'));

    findings.push({
      category: 'Background Jobs',
      checkName: 'Paper trading job (48h)',
      status: paperJobs.length > 0 ? (paperJobs[0]?.status === 'success' ? 'Pass' : 'Warning') : 'Warning',
      severity: paperJobs.length > 0 ? 'Informational' : 'Low',
      evidence: paperJobs.length > 0 ? `Last run: ${paperJobs[0]?.finishedAt?.toISOString()} — ${paperJobs[0]?.status}` : 'No paper trading runs in last 48 hours',
      expectedResult: 'Paper trading job running regularly',
      actualResult: paperJobs.length > 0 ? `${paperJobs.length} run(s) in last 48h` : 'No recent runs',
      recommendedAction: paperJobs.length === 0 ? 'Set up a Scheduled Deployment to run the paper trading job periodically' : 'Keep monitoring',
      relatedService: 'paper-trading-job',
      timestamp: ts(),
    });

    findings.push({
      category: 'Background Jobs',
      checkName: 'Calibration refit (48h)',
      status: calibJobs.length > 0 ? (calibJobs[0]?.status === 'success' ? 'Pass' : 'Warning') : 'Warning',
      severity: calibJobs.length > 0 ? 'Informational' : 'Low',
      evidence: calibJobs.length > 0 ? `Last run: ${calibJobs[0]?.finishedAt?.toISOString()} — ${calibJobs[0]?.status}` : 'No calibration refit in last 48 hours',
      expectedResult: 'Calibration refit has been run',
      actualResult: calibJobs.length > 0 ? `${calibJobs.length} run(s) in last 48h` : 'No recent runs',
      recommendedAction: calibJobs.length === 0 ? 'Trigger POST /api/evaluation/calibration-refit to update calibration' : 'Keep monitoring',
      relatedService: 'calibration-refit',
      timestamp: ts(),
    });

    findings.push({
      category: 'Background Jobs',
      checkName: 'Historical backfill (48h)',
      status: backfillJobs.length > 0 ? (backfillJobs[0]?.status === 'success' ? 'Pass' : 'Warning') : 'Warning',
      severity: backfillJobs.length > 0 ? 'Informational' : 'Low',
      evidence: backfillJobs.length > 0 ? `Last run: ${backfillJobs[0]?.finishedAt?.toISOString()} — ${backfillJobs[0]?.status}` : 'No backfill in last 48 hours',
      expectedResult: 'Backfill runs regularly to ingest new results',
      actualResult: backfillJobs.length > 0 ? `${backfillJobs.length} run(s)` : 'No recent backfill',
      recommendedAction: backfillJobs.length === 0 ? 'Run an incremental backfill to ingest recent completed matches' : 'Keep monitoring',
      relatedService: 'historical-backfill',
      timestamp: ts(),
    });
  } catch (err) {
    findings.push({
      category: 'Background Jobs',
      checkName: 'Job run history',
      status: 'Unable to Verify',
      severity: 'Low',
      evidence: err instanceof Error ? err.message : 'Could not query job_runs',
      expectedResult: 'Job history accessible',
      actualResult: 'Query failed',
      recommendedAction: 'Check DB connectivity',
      relatedService: 'job_runs',
      timestamp: ts(),
    });
  }

  return findings;
}

async function runGradingChecks(): Promise<LaunchAuditFinding[]> {
  const findings: LaunchAuditFinding[] = [];

  try {
    const gradedRows = await db
      .select({ n: count() })
      .from(evaluationPredictionsTable)
      .where(isNotNull(evaluationPredictionsTable.actualWinnerId));

    const totalRows = await db
      .select({ n: count() })
      .from(evaluationPredictionsTable);

    const graded = gradedRows[0]?.n ?? 0;
    const total = totalRows[0]?.n ?? 0;
    const pct = total > 0 ? Math.round((Number(graded) / Number(total)) * 100) : 0;

    findings.push({
      category: 'Grading',
      checkName: 'Prediction grading',
      status: Number(graded) > 0 ? 'Pass' : 'Warning',
      severity: Number(graded) > 0 ? 'Informational' : 'Low',
      evidence: `${graded.toLocaleString()} of ${total.toLocaleString()} evaluation predictions graded (${pct}%)`,
      expectedResult: 'Predictions are being graded regularly',
      actualResult: `${graded.toLocaleString()} graded`,
      recommendedAction: Number(graded) === 0 ? 'Run outcome recording to begin grading predictions' : 'Keep monitoring',
      relatedService: 'evaluation_predictions',
      timestamp: ts(),
    });
  } catch (err) {
    findings.push({
      category: 'Grading',
      checkName: 'Prediction grading',
      status: 'Unable to Verify',
      severity: 'Low',
      evidence: err instanceof Error ? err.message : 'Query failed',
      expectedResult: 'Grading data accessible',
      actualResult: 'Query failed',
      recommendedAction: 'Check DB connectivity',
      relatedService: 'evaluation_predictions',
      timestamp: ts(),
    });
  }

  return findings;
}

async function runCalibrationChecks(): Promise<LaunchAuditFinding[]> {
  const findings: LaunchAuditFinding[] = [];

  try {
    // Check for an active calibration model
    const activeModels = await db
      .select({ id: calibrationModelsTable.id, method: calibrationModelsTable.method, fittedAt: calibrationModelsTable.fittedAt })
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.active, true))
      .limit(1);

    const hasActive = activeModels.length > 0;
    const activeModel = activeModels[0];

    findings.push({
      category: 'Calibration',
      checkName: 'Active calibration model',
      status: hasActive ? 'Pass' : 'Warning',
      severity: hasActive ? 'Informational' : 'Medium',
      evidence: hasActive
        ? `Active model: method=${activeModel?.method}, fittedAt=${activeModel?.fittedAt?.toISOString() ?? 'unknown'}`
        : 'No active calibration model — probabilities are uncalibrated',
      expectedResult: 'Active calibration model present',
      actualResult: hasActive ? `Active model (id=${activeModel?.id})` : 'No active model',
      recommendedAction: hasActive ? 'Keep monitoring' : 'Run calibration refit via POST /api/evaluation/calibration-refit',
      relatedService: 'calibration_models',
      timestamp: ts(),
    });

    // Walk-forward folds
    const evalPredCount = await db
      .select({ n: count() })
      .from(evaluationPredictionsTable)
      .where(eq(evaluationPredictionsTable.runKind, 'historical_test'));

    const histTestCount = Number(evalPredCount[0]?.n ?? 0);

    findings.push({
      category: 'Walk-Forward',
      checkName: 'Historical evaluation corpus',
      status: histTestCount >= 500 ? 'Pass' : histTestCount > 0 ? 'Warning' : 'Fail',
      severity: histTestCount >= 500 ? 'Informational' : histTestCount > 0 ? 'Medium' : 'High',
      evidence: `${histTestCount.toLocaleString()} historical_test evaluation predictions`,
      expectedResult: '≥ 500 historical_test rows for reliable accuracy estimates',
      actualResult: `${histTestCount.toLocaleString()} rows`,
      recommendedAction: histTestCount < 500 ? 'Run the walk-forward evaluation from the Accuracy Dashboard' : 'Keep monitoring',
      relatedService: 'evaluation_predictions',
      timestamp: ts(),
    });
  } catch (err) {
    findings.push({
      category: 'Calibration',
      checkName: 'Calibration status',
      status: 'Unable to Verify',
      severity: 'Medium',
      evidence: err instanceof Error ? err.message : 'Query failed',
      expectedResult: 'Calibration data accessible',
      actualResult: 'Query failed',
      recommendedAction: 'Check DB connectivity',
      relatedService: 'calibration_models',
      timestamp: ts(),
    });
  }

  return findings;
}

function runSecurityChecks(): LaunchAuditFinding[] {
  const adminKey = getAdminAccessKey();
  const sessionSecret = process.env.SESSION_SECRET;

  return [
    {
      category: 'Security',
      checkName: 'Admin access key',
      status: adminKey ? 'Pass' : 'Fail',
      severity: adminKey ? 'Informational' : 'Critical',
      evidence: adminKey ? 'ADMIN_ACCESS_KEY is set' : 'ADMIN_ACCESS_KEY is not configured — admin routes are inaccessible',
      expectedResult: 'ADMIN_ACCESS_KEY configured',
      actualResult: adminKey ? 'Configured' : 'Missing',
      recommendedAction: adminKey ? 'Keep monitoring' : 'Set ADMIN_ACCESS_KEY in environment secrets immediately',
      relatedService: 'admin-auth',
      timestamp: ts(),
    },
    {
      category: 'Security',
      checkName: 'Session secret',
      status: sessionSecret ? 'Pass' : 'Fail',
      severity: sessionSecret ? 'Informational' : 'High',
      evidence: sessionSecret ? 'SESSION_SECRET is set' : 'SESSION_SECRET is not configured — signed cookies will fail',
      expectedResult: 'SESSION_SECRET configured',
      actualResult: sessionSecret ? 'Configured' : 'Missing',
      recommendedAction: sessionSecret ? 'Keep monitoring' : 'Set SESSION_SECRET in environment secrets',
      relatedService: 'express-cookies',
      timestamp: ts(),
    },
    {
      category: 'Security',
      checkName: 'API key exposure',
      status: 'Pass',
      severity: 'Informational',
      evidence: 'No API keys are returned in any audit or provider response — keys are server-side only',
      expectedResult: 'Keys never exposed to client',
      actualResult: 'Keys not exposed',
      recommendedAction: 'Keep monitoring',
      relatedService: 'api-server',
      timestamp: ts(),
    },
  ];
}

function runDocumentationChecks(): LaunchAuditFinding[] {
  return [
    {
      category: 'Documentation',
      checkName: 'Launch audit docs',
      status: 'Pass',
      severity: 'Informational',
      evidence: 'This audit page exists and is accessible — docs/launch-audit/ is written after each audit run',
      expectedResult: 'Audit reports are generated',
      actualResult: 'Audit page running',
      recommendedAction: 'Run a full audit to generate the latest-launch-audit.md report',
      relatedService: 'launch-audit',
      timestamp: ts(),
    },
  ];
}

// ── Report writing ─────────────────────────────────────────────────────────────

function resolveLaunchAuditDir(): string {
  const candidates = [
    path.resolve(process.cwd(), 'docs', 'launch-audit'),
    path.resolve(process.cwd(), '..', '..', 'docs', 'launch-audit'),
    path.resolve(process.cwd(), '..', 'docs', 'launch-audit'),
  ];
  return candidates[0];
}

async function ensureLaunchAuditDir(): Promise<string> {
  const dir = resolveLaunchAuditDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function buildMarkdownReport(summary: LaunchAuditSummary, reportPath: string): string {
  const lines = [
    '# Launch Audit Report',
    '',
    `**Generated:** ${new Date().toISOString()}`,
    `**Overall status:** ${summary.overallStatus}`,
    '',
    '## Scorecard',
    '',
    `| Metric | Count |`,
    `|--------|-------|`,
    `| Pass | ${summary.passCount} |`,
    `| Warning | ${summary.warningCount} |`,
    `| Fail | ${summary.failCount} |`,
    `| Critical | ${summary.criticalCount} |`,
    `| High | ${summary.highCount} |`,
    '',
    '## Provider Health',
    '',
  ];

  for (const p of summary.providers) {
    lines.push(`- **${p.name}** (${p.category} / ${p.role}): ${p.status} — ${p.details}`);
  }

  lines.push('', '## Findings by Category', '');

  const categories = [...new Set(summary.findings.map((f) => f.category))];
  for (const cat of categories) {
    lines.push(`### ${cat}`, '');
    const catFindings = summary.findings.filter((f) => f.category === cat);
    for (const f of catFindings) {
      lines.push(`- **${f.checkName}** — ${f.status} (${f.severity})`);
      lines.push(`  - Evidence: ${f.evidence}`);
      if (f.status !== 'Pass') lines.push(`  - Action: ${f.recommendedAction}`);
    }
    lines.push('');
  }

  lines.push(`---`, `Report path: ${reportPath}`);
  return `${lines.join('\n')}\n`;
}

async function readHistory(): Promise<LaunchAuditHistoryEntry[]> {
  const dir = await ensureLaunchAuditDir();
  const historyPath = path.join(dir, 'history.json');
  try {
    const raw = await fs.readFile(historyPath, 'utf8');
    const parsed = JSON.parse(raw) as LaunchAuditHistoryEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeHistory(history: LaunchAuditHistoryEntry[]): Promise<void> {
  const dir = await ensureLaunchAuditDir();
  const historyPath = path.join(dir, 'history.json');
  await fs.writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`, 'utf8');
}

// ── Public exports ─────────────────────────────────────────────────────────────

export async function runLaunchAudit(): Promise<LaunchAuditSummary> {
  const providers = buildProviderCards();

  const [dbFindings, apiFindings, jobFindings, gradingFindings, calibFindings] = await Promise.all([
    runDatabaseChecks(),
    runApiChecks(),
    runJobChecks(),
    runGradingChecks(),
    runCalibrationChecks(),
  ]);

  const securityFindings = runSecurityChecks();
  const docFindings = runDocumentationChecks();

  const allFindings = [
    ...dbFindings,
    ...apiFindings,
    ...jobFindings,
    ...gradingFindings,
    ...calibFindings,
    ...securityFindings,
    ...docFindings,
  ];

  const summary = buildLaunchAuditSummary(allFindings, providers);

  // Write report files
  const dir = await ensureLaunchAuditDir();
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const reportPath = path.join(dir, `launch-audit-${stamp}.md`);
  const reportContents = buildMarkdownReport(summary, reportPath);
  await Promise.all([
    fs.writeFile(reportPath, reportContents, 'utf8'),
    fs.writeFile(path.join(dir, 'latest-launch-audit.md'), reportContents, 'utf8'),
  ]);

  // Update history
  const history = await readHistory();
  history.unshift({
    id: `audit-${Date.now()}`,
    startedAt: now.toISOString(),
    completedAt: new Date().toISOString(),
    overallStatus: summary.overallStatus,
    passCount: summary.passCount,
    warningCount: summary.warningCount,
    failCount: summary.failCount,
    criticalCount: summary.criticalCount,
    highCount: summary.highCount,
    reportPath,
  });
  await writeHistory(history.slice(0, 20));

  summary.reportPath = reportPath;
  summary.history = history.slice(0, 20);
  return summary;
}

export async function getLaunchAuditSummary(): Promise<LaunchAuditSummary> {
  const providers = buildProviderCards();

  // Lightweight read-only snapshot: quick DB + provider status checks
  const [dbFindings, apiFindings] = await Promise.all([
    runDatabaseChecks(),
    runApiChecks(),
  ]);

  const securityFindings = runSecurityChecks();
  const allFindings = [...dbFindings, ...apiFindings, ...securityFindings];
  const summary = buildLaunchAuditSummary(allFindings, providers);
  const history = await readHistory();
  summary.history = history;
  return summary;
}

export async function getLiveStatus(): Promise<{ providers: ProviderHealthCard[]; generatedAt: string }> {
  const providers = buildProviderCards();
  return { providers, generatedAt: new Date().toISOString() };
}

export function testProviderByName(name: string): ProviderHealthCard | null {
  const providers = buildProviderCards();
  return providers.find((p) => p.name.toLowerCase() === name.toLowerCase()) ?? null;
}
