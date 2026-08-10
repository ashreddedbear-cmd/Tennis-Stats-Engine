/**
 * Task #12: Candidate optimizer — training-mode walk-forward + candidate config generation.
 *
 * The "Run Optimizer" dashboard action triggers this. It runs the full walk-forward in
 * training mode (evaluationOnly=false), then:
 *  1. Writes a versioned candidate_configs row (never overwrites the active production config).
 *  2. Runs the threshold evaluation job over the freshly-updated graded cohort.
 *
 * The candidate row captures the new calibration + specialist segment weights (proposed config)
 * vs the config active before this run (base config snapshot). Status starts at "pending".
 * Promotion to production requires a separate manual acceptance step -- never auto-promoted.
 *
 * Safety invariants enforced here (also documented on candidateConfigsTable):
 *  - We always INSERT a new candidate_configs row, never UPDATE the active production config.
 *  - The candidate config is read-only after insertion from this path.
 *  - Threshold evaluation (runThresholdEvaluation) only reads graded rows, never writes engine weights.
 */

import { db, calibrationModelsTable, specialistModelsTable, candidateConfigsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { desc } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { runWalkForwardEvaluation, type WalkForwardSummary } from "./walkForward";
import { runThresholdEvaluation } from "./thresholdEvaluation";
import { deriveStrategyIdentity } from "./strategyIdentity";

export interface OptimizerRunSummary {
  walkForwardSummary: WalkForwardSummary;
  candidateConfigId: number;
  candidateConfigIds: number[];
  generatedCount: number;
  duplicateRejectedCount: number;
  nearDuplicateRejectedCount: number;
  retestCount: number;
  diversity: {
    requiredFamilies: string[];
    presentFamilies: string[];
    minimumFamilyCount: number;
    familyCoveragePassed: boolean;
    noveltyFloor: number;
    noveltyRate: number;
    noveltyPassed: boolean;
  };
  thresholdEvaluationId: number;
}

export type OptimizerPhase =
  | "initializing"
  | "walk-forward"
  | "generate"
  | "dedupe"
  | "retest"
  | "score"
  | "compare"
  | "persist"
  | "threshold-eval"
  | "done";

interface StrategySpec {
  family: string;
  selectedFeatures: string[];
  weights: Record<string, number>;
  gates: Record<string, boolean>;
  thresholds: Record<string, number>;
  calibrationMethod: "isotonic" | "platt" | "none";
  specialistRouting: "none" | "active-segments" | "surface-only" | "tour-only";
  objectiveProfile: "conservative" | "aggressive" | "balanced" | "experimental";
  abstentionPolicy: "none" | "strict" | "moderate";
}

interface CandidateDraft {
  name: string;
  notes: string;
  strategySpec: StrategySpec;
  generationMethod: "production-variation" | "historical-challenger" | "randomized" | "specialist" | "competitive-balance" | "reliability-gated" | "minimalist" | "complex-multi-signal" | "contrarian" | "retest";
  parentFingerprint: string | null;
  parentStrategyId?: string | null;
  parentStrategyVersion?: string | null;
}

const REQUIRED_FAMILIES = [
  "production-variation",
  "historical-challenger",
  "randomized",
  "specialist",
  "competitive-balance",
  "reliability-gated",
  "minimalist",
  "complex-multi-signal",
  "contrarian",
] as const;

const NOVELTY_DISTANCE_THRESHOLD = 0.18;
const NOVELTY_FLOOR = 0.6;
const MINIMUM_FAMILY_COUNT = 7;

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash32(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function strategyFingerprint(spec: StrategySpec): string {
  return `sfp_${hash32(stableStringify(spec))}`;
}

function numericDistance(a: number, b: number): number {
  return Math.abs(a - b);
}

function jaccardDistance(a: string[], b: string[]): number {
  const sa = new Set(a);
  const sb = new Set(b);
  const union = new Set([...sa, ...sb]);
  if (union.size === 0) return 0;
  const intersectionCount = [...sa].filter((x) => sb.has(x)).length;
  return 1 - intersectionCount / union.size;
}

function booleanMapDistance(a: Record<string, boolean>, b: Record<string, boolean>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;
  let diff = 0;
  for (const key of keys) {
    if ((a[key] ?? false) !== (b[key] ?? false)) diff += 1;
  }
  return diff / keys.size;
}

function numericMapDistance(a: Record<string, number>, b: Record<string, number>): number {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  if (keys.size === 0) return 0;
  let sum = 0;
  for (const key of keys) {
    sum += numericDistance(a[key] ?? 0, b[key] ?? 0);
  }
  return Math.min(1, sum / keys.size);
}

function strategyDistance(a: StrategySpec, b: StrategySpec): number {
  const components = [
    jaccardDistance(a.selectedFeatures, b.selectedFeatures),
    numericMapDistance(a.weights, b.weights),
    booleanMapDistance(a.gates, b.gates),
    numericMapDistance(a.thresholds, b.thresholds),
    a.calibrationMethod === b.calibrationMethod ? 0 : 1,
    a.specialistRouting === b.specialistRouting ? 0 : 1,
    a.objectiveProfile === b.objectiveProfile ? 0 : 1,
    a.abstentionPolicy === b.abstentionPolicy ? 0 : 1,
  ];
  return components.reduce((sum, c) => sum + c, 0) / components.length;
}

function toStrategySpecFromStored(proposedConfig: unknown): StrategySpec | null {
  if (!proposedConfig || typeof proposedConfig !== "object") return null;
  const strategy = (proposedConfig as Record<string, unknown>)["strategySpec"];
  if (!strategy || typeof strategy !== "object") return null;
  const s = strategy as Record<string, unknown>;
  const selectedFeatures = Array.isArray(s["selectedFeatures"]) ? (s["selectedFeatures"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  const weightsRaw = s["weights"];
  const gatesRaw = s["gates"];
  const thresholdsRaw = s["thresholds"];
  if (selectedFeatures.length === 0 || !weightsRaw || !gatesRaw || !thresholdsRaw) return null;

  const weights: Record<string, number> = {};
  for (const [k, v] of Object.entries(weightsRaw as Record<string, unknown>)) {
    if (typeof v === "number") weights[k] = v;
  }
  const gates: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(gatesRaw as Record<string, unknown>)) {
    if (typeof v === "boolean") gates[k] = v;
  }
  const thresholds: Record<string, number> = {};
  for (const [k, v] of Object.entries(thresholdsRaw as Record<string, unknown>)) {
    if (typeof v === "number") thresholds[k] = v;
  }

  const calibrationMethod = s["calibrationMethod"];
  const specialistRouting = s["specialistRouting"];
  const objectiveProfile = s["objectiveProfile"];
  const abstentionPolicy = s["abstentionPolicy"];
  if (
    (calibrationMethod !== "isotonic" && calibrationMethod !== "platt" && calibrationMethod !== "none") ||
    (specialistRouting !== "none" && specialistRouting !== "active-segments" && specialistRouting !== "surface-only" && specialistRouting !== "tour-only") ||
    (objectiveProfile !== "conservative" && objectiveProfile !== "aggressive" && objectiveProfile !== "balanced" && objectiveProfile !== "experimental") ||
    (abstentionPolicy !== "none" && abstentionPolicy !== "strict" && abstentionPolicy !== "moderate")
  ) {
    return null;
  }

  return {
    family: typeof s["family"] === "string" ? s["family"] : "unknown",
    selectedFeatures,
    weights,
    gates,
    thresholds,
    calibrationMethod,
    specialistRouting,
    objectiveProfile,
    abstentionPolicy,
  };
}

function mutateWeight(base: Record<string, number>, factor: number): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [k, v] of Object.entries(base)) next[k] = Math.round(v * factor * 1000) / 1000;
  return next;
}

function buildCandidateFamilies(baseWeights: Record<string, number>): CandidateDraft[] {
  const coreFeatures = ["surfaceElo", "serveReturn", "recentForm", "modelAgreement", "competitiveBalance", "dataQuality"];
  const baselineGates = {
    useCompetitiveBalanceShrink: true,
    useReliabilityGates: true,
    useSpecialistRouting: true,
    allowStrongRecommendationOnHardMatch: false,
  };
  const baseThresholds = {
    eliteDQFloor: 55,
    tieBand: 3,
    confidenceFloor: 55,
    difficultMatchStrongRecommendationBlock: 1,
  };

  return [
    {
      name: "CBE Production Variation — Conservative",
      notes: "Production-adjacent conservative strategy with tighter hard-match gating and abstention.",
      generationMethod: "production-variation",
      parentFingerprint: null,
      strategySpec: {
        family: "production-variation",
        selectedFeatures: coreFeatures,
        weights: mutateWeight(baseWeights, 0.95),
        gates: { ...baselineGates },
        thresholds: { ...baseThresholds, confidenceFloor: 58, tieBand: 4 },
        calibrationMethod: "isotonic",
        specialistRouting: "active-segments",
        objectiveProfile: "conservative",
        abstentionPolicy: "strict",
      },
    },
    {
      name: "Historical Challenger Revival",
      notes: "Re-introduces previously competitive reliability profile with milder abstention.",
      generationMethod: "historical-challenger",
      parentFingerprint: null,
      strategySpec: {
        family: "historical-challenger",
        selectedFeatures: [...coreFeatures, "upsetRisk", "modelConflict"],
        weights: { ...baseWeights, recentForm: 1.1, serveReturn: 1.35 },
        gates: { ...baselineGates, useReliabilityGates: false },
        thresholds: { ...baseThresholds, confidenceFloor: 54 },
        calibrationMethod: "isotonic",
        specialistRouting: "tour-only",
        objectiveProfile: "balanced",
        abstentionPolicy: "moderate",
      },
    },
    {
      name: "Randomized Blend Candidate",
      notes: "Randomized weight perturbation seeded from the active strategy for exploration.",
      generationMethod: "randomized",
      parentFingerprint: null,
      strategySpec: {
        family: "randomized",
        selectedFeatures: [...coreFeatures, "upsetRisk"],
        weights: {
          ...baseWeights,
          surfaceElo: 1.42,
          serveReturn: 1.61,
          recentForm: 1.02,
          headToHead: 0.27,
          matchLoadRecovery: 0.12,
        },
        gates: { ...baselineGates, allowStrongRecommendationOnHardMatch: true },
        thresholds: { ...baseThresholds, eliteDQFloor: 52, difficultMatchStrongRecommendationBlock: 0 },
        calibrationMethod: "platt",
        specialistRouting: "surface-only",
        objectiveProfile: "experimental",
        abstentionPolicy: "none",
      },
    },
    {
      name: "Specialist-Heavy Strategy",
      notes: "Prioritizes specialist routes where segment support exists.",
      generationMethod: "specialist",
      parentFingerprint: null,
      strategySpec: {
        family: "specialist",
        selectedFeatures: [...coreFeatures, "segmentSpecialist"],
        weights: { ...baseWeights, recentForm: 0.9, surfaceElo: 1.65 },
        gates: { ...baselineGates, useSpecialistRouting: true },
        thresholds: { ...baseThresholds, confidenceFloor: 56 },
        calibrationMethod: "isotonic",
        specialistRouting: "active-segments",
        objectiveProfile: "balanced",
        abstentionPolicy: "moderate",
      },
    },
    {
      name: "Competitive Balance Tier Strategy",
      notes: "Aggressive difficulty-tier gating that suppresses high-balance confidence.",
      generationMethod: "competitive-balance",
      parentFingerprint: null,
      strategySpec: {
        family: "competitive-balance",
        selectedFeatures: [...coreFeatures, "competitiveBalanceTier", "matchupCloseness"],
        weights: { ...baseWeights, serveReturn: 1.2, recentForm: 0.95 },
        gates: { ...baselineGates, useCompetitiveBalanceShrink: true },
        thresholds: { ...baseThresholds, difficultMatchStrongRecommendationBlock: 1, confidenceFloor: 57 },
        calibrationMethod: "isotonic",
        specialistRouting: "none",
        objectiveProfile: "conservative",
        abstentionPolicy: "strict",
      },
    },
    {
      name: "Evidence Reliability Strategy",
      notes: "Weights and gates keyed to reliability strength before confidence assertions.",
      generationMethod: "reliability-gated",
      parentFingerprint: null,
      strategySpec: {
        family: "reliability-gated",
        selectedFeatures: [...coreFeatures, "surfaceSampleDepth", "dataQuality"],
        weights: { ...baseWeights, surfaceElo: 1.58, serveReturn: 1.28, recentForm: 0.85 },
        gates: { ...baselineGates, useReliabilityGates: true },
        thresholds: { ...baseThresholds, eliteDQFloor: 60, confidenceFloor: 58 },
        calibrationMethod: "isotonic",
        specialistRouting: "surface-only",
        objectiveProfile: "conservative",
        abstentionPolicy: "strict",
      },
    },
    {
      name: "Minimalist Core Strategy",
      notes: "Minimal low-feature strategy as a simplicity challenger baseline.",
      generationMethod: "minimalist",
      parentFingerprint: null,
      strategySpec: {
        family: "minimalist",
        selectedFeatures: ["surfaceElo", "serveReturn", "dataQuality"],
        weights: { surfaceElo: 1.7, serveReturn: 1.4, recentForm: 0, headToHead: 0, fatigue: 0, availability: 0, matchLoadRecovery: 0 },
        gates: {
          useCompetitiveBalanceShrink: true,
          useReliabilityGates: true,
          useSpecialistRouting: false,
          allowStrongRecommendationOnHardMatch: false,
        },
        thresholds: { ...baseThresholds, tieBand: 4, confidenceFloor: 57 },
        calibrationMethod: "none",
        specialistRouting: "none",
        objectiveProfile: "balanced",
        abstentionPolicy: "strict",
      },
    },
    {
      name: "Complex Multi-Signal Strategy",
      notes: "High-complexity strategy blending broad signals and gates.",
      generationMethod: "complex-multi-signal",
      parentFingerprint: null,
      strategySpec: {
        family: "complex-multi-signal",
        selectedFeatures: [
          ...coreFeatures,
          "upsetRisk",
          "modelConflict",
          "segmentSpecialist",
          "simulation",
          "surfaceSampleDepth",
          "headToHead",
          "availability",
        ],
        weights: { ...baseWeights, surfaceElo: 1.6, serveReturn: 1.45, recentForm: 1.25, headToHead: 0.25 },
        gates: { ...baselineGates, useSpecialistRouting: true, allowStrongRecommendationOnHardMatch: true },
        thresholds: { ...baseThresholds, eliteDQFloor: 54, tieBand: 2, confidenceFloor: 53 },
        calibrationMethod: "isotonic",
        specialistRouting: "active-segments",
        objectiveProfile: "aggressive",
        abstentionPolicy: "moderate",
      },
    },
    {
      name: "Contrarian Off-Wall Candidate",
      notes: "Materially different contrarian profile for discovery pressure.",
      generationMethod: "contrarian",
      parentFingerprint: null,
      strategySpec: {
        family: "contrarian",
        selectedFeatures: ["recentForm", "upsetRisk", "modelAgreement", "competitiveBalance", "headToHead"],
        weights: { surfaceElo: 0.8, serveReturn: 0.75, recentForm: 1.65, headToHead: 0.6, fatigue: 0.2, availability: 0.15, matchLoadRecovery: 0.1 },
        gates: {
          useCompetitiveBalanceShrink: true,
          useReliabilityGates: false,
          useSpecialistRouting: false,
          allowStrongRecommendationOnHardMatch: true,
        },
        thresholds: { ...baseThresholds, eliteDQFloor: 45, tieBand: 2, confidenceFloor: 52, difficultMatchStrongRecommendationBlock: 0 },
        calibrationMethod: "platt",
        specialistRouting: "none",
        objectiveProfile: "experimental",
        abstentionPolicy: "none",
      },
    },
  ];
}

/**
 * Runs the full walk-forward in training mode, writes a new candidate_configs row,
 * and runs threshold evaluation. Returns a summary of what was produced.
 *
 * The caller (route handler) is responsible for ensuring only one optimizer run is active
 * at a time -- this function has no built-in concurrency guard because the walk-forward
 * itself wipes and rewrites historical_test rows up front, making concurrent runs
 * self-defeating rather than silently corrupt.
 */
export async function runOptimizerRun(
  options: { foldCount?: number; warmupFraction?: number; notes?: string; onPhase?: (phase: OptimizerPhase) => void } = {},
): Promise<OptimizerRunSummary> {
  logger.info({ options }, "Task #12: optimizer run started (training mode)");
  options.onPhase?.("initializing");
  const optimizerRunId = `OPT-${new Date().getUTCFullYear()}-${String(Math.abs(Date.now()) % 10000).padStart(4, "0")}`;

  // Snapshot the currently-active calibration BEFORE the training run overwrites it.
  const [activeCalibrationBefore] = await db.select().from(calibrationModelsTable).where(eq(calibrationModelsTable.active, true)).limit(1);
  const activeSpecialistsBefore = await db.select().from(specialistModelsTable);

  const baseConfigSnapshot = {
    calibration: activeCalibrationBefore
      ? {
          id: activeCalibrationBefore.id,
          method: activeCalibrationBefore.method,
          validationSampleSize: activeCalibrationBefore.validationSampleSize,
          isotonicHoldoutLogLoss: activeCalibrationBefore.isotonicHoldoutLogLoss,
          plattHoldoutLogLoss: activeCalibrationBefore.plattHoldoutLogLoss,
        }
      : null,
    specialistSegments: activeSpecialistsBefore.map((s) => ({
      segmentKey: s.segmentKey,
      weight: s.weight,
      meetsThreshold: s.meetsThreshold,
      validationSampleSize: s.validationSampleSize,
    })),
  };

  // Run the full training walk-forward (evaluationOnly=false). This will:
  // - Refit calibration_models
  // - Refit specialist_models
  // - Run runPatternAnalysis() automatically at the end
  options.onPhase?.("walk-forward");
  // Task #198: requireApproval=true stores the new model as pending rather than auto-activating.
  // The optimizer snapshot below reads from the pending row (by pendingModelId) when present,
  // so the candidate config always reflects the newly-fitted model rather than the prior active one.
  const wfSummary = await runWalkForwardEvaluation({ foldCount: options.foldCount, warmupFraction: options.warmupFraction, evaluationOnly: false, optimizerRunId, requireApproval: true });

  // Snapshot the newly-fitted calibration and specialists (proposed config).
  // When requireApproval=true, the new calibration is pending (active=false) and its specialist
  // data is stored as JSONB on the pending row rather than written to specialist_models.
  // Use pendingModelId to read the pending row directly so the snapshot is accurate.
  let pendingCalibrationAfter: (typeof calibrationModelsTable.$inferSelect) | undefined;
  if (wfSummary.pendingModelId) {
    const [row] = await db
      .select()
      .from(calibrationModelsTable)
      .where(eq(calibrationModelsTable.id, wfSummary.pendingModelId))
      .limit(1);
    pendingCalibrationAfter = row;
  }

  // When a pending model exists, specialists are in its JSONB blob (not yet in specialist_models).
  // Fall back to the live specialist_models table only when there is no pending model.
  type SpecialistSnapshot = { segmentKey: string; weight: number | null; meetsThreshold: boolean | null; validationSampleSize: number | null; logLoss: number | null; accuracy: number | null };
  let specialistsForSnapshot: SpecialistSnapshot[];
  if (pendingCalibrationAfter?.pendingSpecialistData) {
    const blob = pendingCalibrationAfter.pendingSpecialistData as Record<string, unknown>[];
    specialistsForSnapshot = blob.map((s) => ({
      segmentKey: String(s["segmentKey"] ?? ""),
      weight: typeof s["weight"] === "number" ? s["weight"] : null,
      meetsThreshold: typeof s["meetsThreshold"] === "boolean" ? s["meetsThreshold"] : null,
      validationSampleSize: typeof s["validationSampleSize"] === "number" ? s["validationSampleSize"] : null,
      logLoss: typeof s["logLoss"] === "number" ? s["logLoss"] : null,
      accuracy: typeof s["accuracy"] === "number" ? s["accuracy"] : null,
    }));
  } else {
    const rows = await db.select().from(specialistModelsTable);
    specialistsForSnapshot = rows.map((s) => ({
      segmentKey: s.segmentKey,
      weight: s.weight,
      meetsThreshold: s.meetsThreshold,
      validationSampleSize: s.validationSampleSize,
      logLoss: s.logLoss,
      accuracy: s.accuracy,
    }));
  }

  // For weight-diff, compare against the live specialist_models (unchanged until approval).
  const activeSpecialistsAfter = await db.select().from(specialistModelsTable);

  const snapshotCalibration = pendingCalibrationAfter ?? undefined;
  const proposedConfig = {
    calibration: snapshotCalibration
      ? {
          id: snapshotCalibration.id,
          method: snapshotCalibration.method,
          validationSampleSize: snapshotCalibration.validationSampleSize,
          knots: snapshotCalibration.mapping,
          isotonicHoldoutLogLoss: snapshotCalibration.isotonicHoldoutLogLoss,
          plattHoldoutLogLoss: snapshotCalibration.plattHoldoutLogLoss,
        }
      : null,
    specialistSegments: specialistsForSnapshot.map((s) => ({
      segmentKey: s.segmentKey,
      weight: s.weight,
      meetsThreshold: s.meetsThreshold,
      validationSampleSize: s.validationSampleSize,
      logLoss: s.logLoss,
      accuracy: s.accuracy,
    })),
  };

  // Compute weight diff (proposed vs base specialist weights).
  // Use specialistsForSnapshot (pending JSONB data or live table fallback) as the "after"
  // source so the diff reflects the newly-fitted weights, not the unchanged live table.
  const weightDiff: Record<string, unknown> = {};
  for (const after of specialistsForSnapshot) {
    const before = activeSpecialistsBefore.find((b) => b.segmentKey === after.segmentKey);
    weightDiff[after.segmentKey] = { from: before?.weight ?? null, to: after.weight };
  }
  // Also record segments that existed before but are absent from the proposed snapshot.
  for (const before of activeSpecialistsBefore) {
    if (!specialistsForSnapshot.find((s) => s.segmentKey === before.segmentKey)) {
      weightDiff[before.segmentKey] = { from: before.weight, to: null };
    }
  }

  // Compute validation + holdout metrics from the freshly-written fold data
  // (fold metrics are already in evaluation_runs, summarized here for the candidate row)
  const validationMetrics = {
    foldsRun: wfSummary.foldsRun,
    foldIds: wfSummary.foldIds,
    fallbackRate: wfSummary.fallbackRate,
    warnings: wfSummary.warnings,
  };

  const baseWeights: Record<string, number> = {
    surfaceElo: 1.5,
    serveReturn: 1.5,
    recentForm: 1.3,
    fatigue: 0.4,
    headToHead: 0.4,
    availability: 0.4,
    matchLoadRecovery: 0.3,
  };

  options.onPhase?.("generate");
  const familyCandidates = buildCandidateFamilies(baseWeights);

  // Retest old strategy candidates by carrying their exact strategy spec into this run as retest
  // entries (new evidence snapshot, same fingerprint/strategy).
  options.onPhase?.("retest");
  const existingRows = await db.select().from(candidateConfigsTable).orderBy(desc(candidateConfigsTable.createdAt)).limit(400);
  const retestSeeds: CandidateDraft[] = existingRows
    .filter((row) => row.status === "approved" || row.status === "rejected" || row.status === "pending" || row.status === "under-review")
    .slice(0, 24)
    .map((row): CandidateDraft | null => {
      const existingStrategy = toStrategySpecFromStored(row.proposedConfig);
      if (!existingStrategy) return null;
      const fp = strategyFingerprint(existingStrategy);
      return {
        name: `Retest — ${row.name}`,
        notes: `Periodic retest of historical candidate #${row.id} on newly refreshed folds.`,
        strategySpec: existingStrategy,
        generationMethod: "retest" as const,
        parentFingerprint: fp,
        parentStrategyId: typeof row.strategyId === "string" ? row.strategyId : null,
        parentStrategyVersion: typeof row.strategyVersion === "string" ? row.strategyVersion : null,
      };
    })
    .filter((x): x is CandidateDraft => x !== null)
    .slice(0, 4);

  const allDrafts = [...familyCandidates, ...retestSeeds];

  options.onPhase?.("dedupe");
  const existingStrategies = existingRows
    .map((row) => toStrategySpecFromStored(row.proposedConfig))
    .filter((x): x is StrategySpec => x !== null);
  const existingFingerprints = new Set(existingStrategies.map((s) => strategyFingerprint(s)));
  const acceptedDrafts: CandidateDraft[] = [];
  const acceptedSpecs: StrategySpec[] = [];
  let duplicateRejectedCount = 0;
  let nearDuplicateRejectedCount = 0;

  for (const draft of allDrafts) {
    const fingerprint = strategyFingerprint(draft.strategySpec);
    if (existingFingerprints.has(fingerprint) && draft.generationMethod !== "retest") {
      duplicateRejectedCount += 1;
      continue;
    }
    const nearExisting = existingStrategies.some((s) => strategyDistance(s, draft.strategySpec) < NOVELTY_DISTANCE_THRESHOLD);
    const nearAccepted = acceptedSpecs.some((s) => strategyDistance(s, draft.strategySpec) < NOVELTY_DISTANCE_THRESHOLD);
    if ((nearExisting || nearAccepted) && draft.generationMethod !== "retest") {
      nearDuplicateRejectedCount += 1;
      continue;
    }
    acceptedDrafts.push(draft);
    acceptedSpecs.push(draft.strategySpec);
  }

  options.onPhase?.("compare");
  const presentFamilies = Array.from(new Set(acceptedDrafts.map((d) => d.generationMethod)));
  const familyCoveragePassed = presentFamilies.length >= MINIMUM_FAMILY_COUNT;
  const noveltyScores = acceptedSpecs.map((spec, idx) => {
    const baselineDistance = strategyDistance(
      {
        family: "production",
        selectedFeatures: ["surfaceElo", "serveReturn", "recentForm", "modelAgreement", "competitiveBalance", "dataQuality"],
        weights: baseWeights,
        gates: {
          useCompetitiveBalanceShrink: true,
          useReliabilityGates: true,
          useSpecialistRouting: true,
          allowStrongRecommendationOnHardMatch: false,
        },
        thresholds: {
          eliteDQFloor: 55,
          tieBand: 3,
          confidenceFloor: 55,
          difficultMatchStrongRecommendationBlock: 1,
        },
        calibrationMethod: "isotonic",
        specialistRouting: "active-segments",
        objectiveProfile: "balanced",
        abstentionPolicy: "moderate",
      },
      spec,
    );
    const localNeighbor = acceptedSpecs
      .filter((_, j) => j !== idx)
      .reduce((best, other) => Math.min(best, strategyDistance(spec, other)), 1);
    return Math.max(baselineDistance, localNeighbor);
  });
  const noveltyRate = noveltyScores.length > 0 ? noveltyScores.filter((s) => s >= NOVELTY_DISTANCE_THRESHOLD).length / noveltyScores.length : 0;
  const noveltyPassed = noveltyRate >= NOVELTY_FLOOR;

  const acceptanceChecks = [
    {
      check: "minimum_folds",
      passed: wfSummary.foldsRun >= 2,
      detail: `${wfSummary.foldsRun} folds ran (minimum 2 required)`,
    },
    {
      check: "calibration_fitted",
      passed: snapshotCalibration !== undefined,
      detail: snapshotCalibration ? `Method: ${snapshotCalibration.method}` : "No calibration row written",
    },
    {
      check: "no_skipped_matches",
      passed: !wfSummary.skippedNoEligibleMatches,
      detail: wfSummary.skippedNoEligibleMatches ? "Skipped due to insufficient matches" : "All eligible matches scored",
    },
    {
      check: "diversity_floor_met",
      passed: familyCoveragePassed,
      detail: `Families present=${presentFamilies.length}, minimum=${MINIMUM_FAMILY_COUNT}`,
    },
    {
      check: "novelty_floor_met",
      passed: noveltyPassed,
      detail: `Novelty rate=${(noveltyRate * 100).toFixed(1)}%, minimum=${(NOVELTY_FLOOR * 100).toFixed(1)}%`,
    },
    {
      check: "retest_quota_met",
      passed: retestSeeds.length >= 2,
      detail: `Retest candidates added=${retestSeeds.length}, minimum=2`,
    },
    {
      check: "duplicate_rate_within_limit",
      passed: allDrafts.length === 0 ? true : (duplicateRejectedCount + nearDuplicateRejectedCount) / allDrafts.length <= 0.6,
      detail: `Rejected=${duplicateRejectedCount + nearDuplicateRejectedCount}/${allDrafts.length} (duplicates=${duplicateRejectedCount}, near-duplicates=${nearDuplicateRejectedCount})`,
    },
  ];

  options.onPhase?.("persist");
  const insertedIds: number[] = [];
  for (const draft of acceptedDrafts) {
    const fingerprint = strategyFingerprint(draft.strategySpec);
    const identity = deriveStrategyIdentity({
      strategyName: draft.name,
      strategyFamily: draft.strategySpec.family,
      strategyFingerprint: fingerprint,
      parentStrategyId: draft.parentStrategyId ?? null,
      parentStrategyVersion: draft.parentStrategyVersion ?? null,
      creationMethod: draft.generationMethod,
      createdAt: new Date(),
    });
    const [row] = await db
      .insert(candidateConfigsTable)
      .values({
        strategyId: identity.strategyId,
        strategyVersion: identity.strategyVersion,
        strategyName: draft.name,
        strategyFamily: draft.strategySpec.family,
        strategyFingerprint: fingerprint,
        parentStrategyId: draft.parentStrategyId ?? null,
        parentStrategyVersion: draft.parentStrategyVersion ?? null,
        creationMethod: draft.generationMethod,
        optimizerRunId,
        lastTestedAt: new Date(),
        productionStatus: "candidate",
        lifecycleStatus: "generated",
        validationStatus: acceptanceChecks.every((c) => c.passed) ? "passed" : "pending",
        walkForwardStatus: wfSummary.foldsRun > 0 ? "passed" : "pending",
        shadowStatus: "pending",
        featureSet: { selectedFeatures: draft.strategySpec.selectedFeatures },
        weights: draft.strategySpec.weights,
        thresholds: draft.strategySpec.thresholds,
        calibrationMethod: draft.strategySpec.calibrationMethod,
        specialistRouting: draft.strategySpec.specialistRouting,
        competitiveBalanceBehavior: { useCompetitiveBalanceShrink: draft.strategySpec.gates.useCompetitiveBalanceShrink },
        evidenceReliabilityBehavior: { useReliabilityGates: draft.strategySpec.gates.useReliabilityGates },
        abstentionRules: { policy: draft.strategySpec.abstentionPolicy },
        recommendationGates: { allowStrongRecommendationOnHardMatch: draft.strategySpec.gates.allowStrongRecommendationOnHardMatch },
        promotedAt: null,
        promotedBy: null,
        rollbackStrategyId: null,
        name: draft.name,
        notes: `${draft.notes} ${options.notes ?? ""}`.trim(),
        status: "pending",
        sourceRunId: null,
        weightDiff,
        thresholdDiff: {},
        proposedConfig: {
          ...proposedConfig,
          strategySpec: draft.strategySpec,
          strategyFingerprint: fingerprint,
          familyTag: draft.generationMethod,
          lineage: {
            parentFingerprint: draft.parentFingerprint,
            generationMethod: draft.generationMethod,
            generatedAt: new Date().toISOString(),
          },
        } as unknown as Record<string, unknown>,
        validationMetrics: {
          ...validationMetrics,
          strategyFingerprint: fingerprint,
          familyTag: draft.generationMethod,
          diversity: {
            requiredFamilies: [...REQUIRED_FAMILIES],
            presentFamilies,
            familyCoveragePassed,
            minimumFamilyCount: MINIMUM_FAMILY_COUNT,
            noveltyRate,
            noveltyFloor: NOVELTY_FLOOR,
            noveltyPassed,
            duplicateRejectedCount,
            nearDuplicateRejectedCount,
            generatedCount: acceptedDrafts.length,
          },
        } as unknown as Record<string, unknown>,
        holdoutMetrics: {
          calibrationMethod: snapshotCalibration?.method ?? null,
          isotonicHoldoutLogLoss: snapshotCalibration?.isotonicHoldoutLogLoss ?? null,
          plattHoldoutLogLoss: snapshotCalibration?.plattHoldoutLogLoss ?? null,
          holdoutSampleSize: snapshotCalibration?.holdoutSampleSize ?? null,
          objectiveProfile: draft.strategySpec.objectiveProfile,
        } as unknown as Record<string, unknown>,
        acceptanceChecksPassed: acceptanceChecks.every((c) => c.passed),
        acceptanceChecks,
      })
      .returning({ id: candidateConfigsTable.id });
    insertedIds.push(row.id);
  }

  // Task #12 invariant: always INSERT, never update the active production config.
  // Using `candidateConfigsTable` insert -- a different table from `calibrationModelsTable`.
  const candidateConfigId = insertedIds[0] ?? -1;

  logger.info(
    {
      candidateConfigId,
      generatedCount: insertedIds.length,
      duplicateRejectedCount,
      nearDuplicateRejectedCount,
      retestCount: retestSeeds.length,
      familyCoveragePassed,
      noveltyPassed,
    },
    "Task #12: candidate config batch inserted (status=pending, never overwrites production)",
  );

  // Run threshold evaluation on the freshly-updated graded cohort.
  options.onPhase?.("threshold-eval");
  const threshEval = await runThresholdEvaluation();

  options.onPhase?.("done");

  logger.info({ candidateConfigId, thresholdEvaluationId: threshEval.id }, "Task #12: optimizer run complete");

  return {
    walkForwardSummary: wfSummary,
    candidateConfigId,
    candidateConfigIds: insertedIds,
    generatedCount: insertedIds.length,
    duplicateRejectedCount,
    nearDuplicateRejectedCount,
    retestCount: retestSeeds.length,
    diversity: {
      requiredFamilies: [...REQUIRED_FAMILIES],
      presentFamilies,
      minimumFamilyCount: MINIMUM_FAMILY_COUNT,
      familyCoveragePassed,
      noveltyFloor: NOVELTY_FLOOR,
      noveltyRate,
      noveltyPassed,
    },
    thresholdEvaluationId: threshEval.id,
  };
}

/** Lists the most recent candidate configs (most recent first). */
export async function listCandidateConfigs(limit = 10) {
  return db.select().from(candidateConfigsTable).orderBy(desc(candidateConfigsTable.createdAt)).limit(limit);
}
