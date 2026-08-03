import { useMutation, useQuery } from "@tanstack/react-query";
import type { QueryFunction, QueryKey, UseMutationOptions, UseMutationResult, UseQueryOptions, UseQueryResult } from "@tanstack/react-query";
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

export interface PaymentEntitlements {
  predictionHistory: boolean;
  walkForward: boolean;
  shadowReplay: boolean;
  optimizer: boolean;
  competitiveBalance: boolean;
  evidenceReliability: boolean;
  developerAnalytics: boolean;
  eliteRecommendations: boolean;
  alerts: boolean;
  teamWorkspace: boolean;
  // Elite-only
  fullModelMonitoring: boolean;
  confidenceCalibration: boolean;
  recommendationPerformance: boolean;
  historicalModelTrends: boolean;
  monteCarlo: boolean;
  eliteBadge: boolean;
  advancedExplanation: boolean;
  confidenceHistory: boolean;
}

export type SubscriptionTier = "free" | "pro" | "pro_annual" | "elite" | "elite_annual" | "team";

export interface PaymentWebhookEventSummary {
  id: number;
  stripeEventId: string;
  eventType: string;
  livemode: boolean;
  processingStatus: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
  createdAt: string;
}

export interface PaymentsStatusResponse {
  featureFlagEnabled: boolean;
  configured: boolean;
  active: boolean;
  tier: SubscriptionTier;
  account: {
    id: number;
    accountKey: string;
    displayName: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    stripePriceId: string | null;
    planKey: string | null;
    planName: string | null;
    subscriptionStatus: string | null;
    accessGrantedAt: string | null;
    currentPeriodStartAt: string | null;
    currentPeriodEndAt: string | null;
    trialEndAt: string | null;
    canceledAt: string | null;
    cancelAtPeriodEnd: boolean;
    entitlementSnapshot: Record<string, boolean>;
    metadata: Record<string, unknown>;
    lastWebhookEventId: string | null;
    lastCheckoutSessionId: string | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  entitlements: PaymentEntitlements;
  stripe: {
    priceId: string | null;
    elitePriceId?: string | null;
    webhookSecretConfigured: boolean;
    secretKeyConfigured: boolean;
    planKey: string;
    planName: string;
  };
  recentWebhookEvents: PaymentWebhookEventSummary[];
}

export interface CreatePaymentsCheckoutSessionBody {
  returnPath?: string;
  customerEmail?: string;
  plan?: "pro" | "pro_annual" | "elite" | "elite_annual" | "team";
}

export interface CreatePaymentsCheckoutSessionResponse {
  sessionId: string;
  url: string | null;
}

export interface CreateBillingPortalSessionBody {
  returnPath?: string;
}

export interface CreateBillingPortalSessionResponse {
  url: string;
}

export interface PaymentsWebhookResponse {
  received: boolean;
  processed: boolean;
  duplicate?: boolean;
}

// ── Admin: workspace-wide status ─────────────────────────────────────────────

export const getPaymentsStatus = async (options?: RequestInit): Promise<PaymentsStatusResponse> => {
  return customFetch<PaymentsStatusResponse>("/api/payments/status", {
    ...options,
    method: "GET",
  });
};

export const getPaymentsStatusQueryKey = () => ["/api/payments/status"] as const;

export const getPaymentsStatusQueryOptions = <TData = Awaited<ReturnType<typeof getPaymentsStatus>>, TError = ErrorType<unknown>>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getPaymentsStatus>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}) => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getPaymentsStatusQueryKey();
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getPaymentsStatus>>> = ({ signal }) => getPaymentsStatus({ signal, ...requestOptions });
  return { queryKey, queryFn, ...queryOptions } as UseQueryOptions<Awaited<ReturnType<typeof getPaymentsStatus>>, TError, TData> & { queryKey: QueryKey };
};

export type GetPaymentsStatusQueryResult = NonNullable<Awaited<ReturnType<typeof getPaymentsStatus>>>;
export type GetPaymentsStatusQueryError = ErrorType<unknown>;

export function useGetPaymentsStatus<TData = Awaited<ReturnType<typeof getPaymentsStatus>>, TError = ErrorType<unknown>>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getPaymentsStatus>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & { queryKey: QueryKey } {
  const queryOptions = getPaymentsStatusQueryOptions(options);
  const query = useQuery(queryOptions) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  return withQueryKey(query, queryOptions.queryKey);
}

// ── User-specific: current signed-in user's billing status ───────────────────

export const getMyPaymentsStatus = async (options?: RequestInit): Promise<PaymentsStatusResponse> => {
  return customFetch<PaymentsStatusResponse>("/api/payments/me/status", {
    ...options,
    method: "GET",
  });
};

export const getMyPaymentsStatusQueryKey = () => ["/api/payments/me/status"] as const;

export const getMyPaymentsStatusQueryOptions = <TData = Awaited<ReturnType<typeof getMyPaymentsStatus>>, TError = ErrorType<unknown>>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getMyPaymentsStatus>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}) => {
  const { query: queryOptions, request: requestOptions } = options ?? {};
  const queryKey = queryOptions?.queryKey ?? getMyPaymentsStatusQueryKey();
  const queryFn: QueryFunction<Awaited<ReturnType<typeof getMyPaymentsStatus>>> = ({ signal }) => getMyPaymentsStatus({ signal, ...requestOptions });
  return { queryKey, queryFn, ...queryOptions } as UseQueryOptions<Awaited<ReturnType<typeof getMyPaymentsStatus>>, TError, TData> & { queryKey: QueryKey };
};

export type GetMyPaymentsStatusQueryResult = NonNullable<Awaited<ReturnType<typeof getMyPaymentsStatus>>>;
export type GetMyPaymentsStatusQueryError = ErrorType<unknown>;

export function useGetMyPaymentsStatus<TData = Awaited<ReturnType<typeof getMyPaymentsStatus>>, TError = ErrorType<unknown>>(options?: {
  query?: UseQueryOptions<Awaited<ReturnType<typeof getMyPaymentsStatus>>, TError, TData>;
  request?: SecondParameter<typeof customFetch>;
}): UseQueryResult<TData, TError> & { queryKey: QueryKey } {
  const queryOptions = getMyPaymentsStatusQueryOptions(options);
  const query = useQuery(queryOptions) as UseQueryResult<TData, TError> & { queryKey: QueryKey };
  return withQueryKey(query, queryOptions.queryKey);
}

// ── Checkout ─────────────────────────────────────────────────────────────────

export const createPaymentsCheckoutSession = async (body: CreatePaymentsCheckoutSessionBody, options?: RequestInit): Promise<CreatePaymentsCheckoutSessionResponse> => {
  return customFetch<CreatePaymentsCheckoutSessionResponse>("/api/payments/checkout-session", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
  });
};

export const createPaymentsCheckoutSessionMutationOptions = <TError = ErrorType<unknown>, TContext = unknown>(options?: {
  mutation?: UseMutationOptions<Awaited<ReturnType<typeof createPaymentsCheckoutSession>>, TError, { data: CreatePaymentsCheckoutSessionBody }, TContext>;
  request?: SecondParameter<typeof customFetch>;
}): UseMutationOptions<Awaited<ReturnType<typeof createPaymentsCheckoutSession>>, TError, { data: CreatePaymentsCheckoutSessionBody }, TContext> => {
  const mutationKey = ["createPaymentsCheckoutSession"];
  const { mutation: mutationOptions, request: requestOptions } = options ? (options.mutation && "mutationKey" in options.mutation && options.mutation.mutationKey ? options : { ...options, mutation: { ...options.mutation, mutationKey } }) : { mutation: { mutationKey }, request: undefined };
  const mutationFn = (props: { data: CreatePaymentsCheckoutSessionBody }) => createPaymentsCheckoutSession(props.data, requestOptions);
  return { mutationFn, ...mutationOptions };
};

export function useCreatePaymentsCheckoutSession<TError = ErrorType<unknown>, TContext = unknown>(options?: {
  mutation?: UseMutationOptions<Awaited<ReturnType<typeof createPaymentsCheckoutSession>>, TError, { data: CreatePaymentsCheckoutSessionBody }, TContext>;
  request?: SecondParameter<typeof customFetch>;
}): UseMutationResult<Awaited<ReturnType<typeof createPaymentsCheckoutSession>>, TError, { data: CreatePaymentsCheckoutSessionBody }, TContext> {
  return useMutation(createPaymentsCheckoutSessionMutationOptions(options));
}

// ── Billing Portal ────────────────────────────────────────────────────────────

export const createBillingPortalSession = async (body: CreateBillingPortalSessionBody, options?: RequestInit): Promise<CreateBillingPortalSessionResponse> => {
  return customFetch<CreateBillingPortalSessionResponse>("/api/payments/billing-portal-session", {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...options?.headers },
    body: JSON.stringify(body),
  });
};

export const createBillingPortalSessionMutationOptions = <TError = ErrorType<unknown>, TContext = unknown>(options?: {
  mutation?: UseMutationOptions<Awaited<ReturnType<typeof createBillingPortalSession>>, TError, { data: CreateBillingPortalSessionBody }, TContext>;
  request?: SecondParameter<typeof customFetch>;
}): UseMutationOptions<Awaited<ReturnType<typeof createBillingPortalSession>>, TError, { data: CreateBillingPortalSessionBody }, TContext> => {
  const mutationKey = ["createBillingPortalSession"];
  const { mutation: mutationOptions, request: requestOptions } = options ? (options.mutation && "mutationKey" in options.mutation && options.mutation.mutationKey ? options : { ...options, mutation: { ...options.mutation, mutationKey } }) : { mutation: { mutationKey }, request: undefined };
  const mutationFn = (props: { data: CreateBillingPortalSessionBody }) => createBillingPortalSession(props.data, requestOptions);
  return { mutationFn, ...mutationOptions };
};

export function useCreateBillingPortalSession<TError = ErrorType<unknown>, TContext = unknown>(options?: {
  mutation?: UseMutationOptions<Awaited<ReturnType<typeof createBillingPortalSession>>, TError, { data: CreateBillingPortalSessionBody }, TContext>;
  request?: SecondParameter<typeof customFetch>;
}): UseMutationResult<Awaited<ReturnType<typeof createBillingPortalSession>>, TError, { data: CreateBillingPortalSessionBody }, TContext> {
  return useMutation(createBillingPortalSessionMutationOptions(options));
}
