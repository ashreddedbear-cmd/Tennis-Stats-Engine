/**
 * Hand-written hooks for evaluation analysis endpoints that are not yet in
 * the generated Orval client.
 *
 * Endpoints covered:
 *  GET  /api/evaluation/pattern-analysis/latest
 *  GET  /api/evaluation/threshold-evaluation/latest
 *  POST /api/paper-trading/run-cycle
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import type {
  QueryFunction,
  QueryKey,
  UseQueryOptions,
  UseQueryResult,
  UseMutationOptions,
  UseMutationResult,
} from "@tanstack/react-query";
import { customFetch } from "./custom-fetch";
import type { ErrorType } from "./custom-fetch";

type AwaitedInput<T> = PromiseLike<T> | T;
type Awaited<O> = O extends AwaitedInput<infer T> ? T : never;
type SecondParameter<T extends (...args: never) => unknown> = Parameters<T>[1];

const withQueryKey = <T extends object, K>(query: T, queryKey: K): T & { queryKey: K } => {
  const result = { queryKey } as T & { queryKey: K };
  for (const key of Object.keys(query)) {
    if (key === "queryKey") continue;
    Object.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      get: () => (query as Record<string, unknown>)[key],
    });
  }
  return result;
};

// ── Pattern Analysis ─────────────────────────────────────────────────────────

export interface PatternSegmentItem {
  segmentKey: string;
  label: string;
  sampleSize: number;
  correctCount: number;
  accuracy: number;
  baselineAccuracy: number;
  lift: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  evidenceStrength: "Strong" | "Moderate" | "Weak" | "Insufficient";
}

export interface LatestPatternAnalysis {
  id: number;
  totalAnalyzed: number;
  segments: PatternSegmentItem[];
  runKindsIncluded: string[];
  createdAt: string;
}

export const getLatestPatternAnalysis = async (options?: RequestInit): Promise<LatestPatternAnalysis | null> =>
  customFetch<LatestPatternAnalysis | null>("/api/evaluation/pattern-analysis/latest", { ...options, method: "GET" });

export const getLatestPatternAnalysisQueryKey = () => ["/api/evaluation/pattern-analysis/latest"] as const;
/** Alias matching the Orval getGet… naming convention used elsewhere in the codebase. */
export const getGetLatestPatternAnalysisQueryKey = getLatestPatternAnalysisQueryKey;

export const getLatestPatternAnalysisQueryOptions = <
  TData = Awaited<ReturnType<typeof getLatestPatternAnalysis>>,
  TError = ErrorType<unknown>,
>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getLatestPatternAnalysis>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}) => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getLatestPatternAnalysisQueryKey();
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getLatestPatternAnalysis>>> = ({ signal }) =>
    getLatestPatternAnalysis({ signal, ...requestOptions });
  return { queryKey, queryFn, ...queryOptions } as UseQueryOptions<
    Awaited<ReturnType<typeof getLatestPatternAnalysis>>,
    TError,
    TData
  > & { queryKey: QueryKey };
};

export type GetLatestPatternAnalysisQueryResult = NonNullable<Awaited<ReturnType<typeof getLatestPatternAnalysis>>>;
export type GetLatestPatternAnalysisQueryError = ErrorType<unknown>;

export function useGetLatestPatternAnalysis<
  TData = Awaited<ReturnType<typeof getLatestPatternAnalysis>>,
  TError = ErrorType<unknown>,
>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getLatestPatternAnalysis>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & { queryKey: QueryKey } {
  const queryOptions = getLatestPatternAnalysisQueryOptions(options);
  const query = useQuery(queryOptions) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  return withQueryKey(query, queryOptions.queryKey);
}

// ── Threshold Evaluation ─────────────────────────────────────────────────────

export interface ThresholdEvalEntryItem {
  tierId: string;
  tierLabel: string;
  currentValue: number | string;
  candidateValue: number | string;
  isWidening: boolean;
  affectedN: number;
  currentAccuracy: number | null;
  candidateAccuracy: number | null;
  currentLogLoss: number | null;
  candidateLogLoss: number | null;
  accuracyDelta: number | null;
  logLossDelta: number | null;
  classification: "Deploy" | "Continue shadow" | "Needs more data" | "Reject" | "Investigate";
  note: string;
}

export interface LatestThresholdEvaluation {
  id: number;
  totalGraded: number;
  thresholds: ThresholdEvalEntryItem[];
  createdAt: string;
}

export const getLatestThresholdEvaluation = async (options?: RequestInit): Promise<LatestThresholdEvaluation | null> =>
  customFetch<LatestThresholdEvaluation | null>("/api/evaluation/threshold-evaluation/latest", { ...options, method: "GET" });

export const getLatestThresholdEvaluationQueryKey = () => ["/api/evaluation/threshold-evaluation/latest"] as const;
/** Alias matching the Orval getGet… naming convention used elsewhere in the codebase. */
export const getGetLatestThresholdEvaluationQueryKey = getLatestThresholdEvaluationQueryKey;

export const getLatestThresholdEvaluationQueryOptions = <
  TData = Awaited<ReturnType<typeof getLatestThresholdEvaluation>>,
  TError = ErrorType<unknown>,
>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getLatestThresholdEvaluation>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}) => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getLatestThresholdEvaluationQueryKey();
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getLatestThresholdEvaluation>>> = ({ signal }) =>
    getLatestThresholdEvaluation({ signal, ...requestOptions });
  return { queryKey, queryFn, ...queryOptions } as UseQueryOptions<
    Awaited<ReturnType<typeof getLatestThresholdEvaluation>>,
    TError,
    TData
  > & { queryKey: QueryKey };
};

export type GetLatestThresholdEvaluationQueryResult = NonNullable<Awaited<ReturnType<typeof getLatestThresholdEvaluation>>>;
export type GetLatestThresholdEvaluationQueryError = ErrorType<unknown>;

export function useGetLatestThresholdEvaluation<
  TData = Awaited<ReturnType<typeof getLatestThresholdEvaluation>>,
  TError = ErrorType<unknown>,
>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getLatestThresholdEvaluation>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & { queryKey: QueryKey } {
  const queryOptions = getLatestThresholdEvaluationQueryOptions(options);
  const query = useQuery(queryOptions) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  return withQueryKey(query, queryOptions.queryKey);
}

// Note: useRunPaperTradingCycle is already in the generated api.ts client.
