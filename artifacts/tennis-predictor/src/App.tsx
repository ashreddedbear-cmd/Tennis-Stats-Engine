import { useEffect, useRef, Suspense, lazy } from 'react';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter, Redirect, useLocation } from 'wouter';
import { Layout } from '@/components/Layout';
import Home from '@/pages/Home';
import PredictBuilderPage from '@/pages/PredictBuilder';
import HistoryPage from '@/pages/History';
import PredictionLogPage from '@/pages/PredictionLog';
import { ClerkProvider, SignIn, SignUp, Show, useClerk, useAuth } from '@clerk/react';
import { useGetAdminAuthStatus } from '@/hooks/useGetAdminAuthStatus';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';

// Lazy-loaded because they pull in recharts (a large charting library) -- keeping them out of
// the main bundle means the home/predict-builder flow (the common path) doesn't pay for a chart
// library it never renders.
const PredictionResultView = lazy(() => import('@/pages/PredictionResultView'));
const AccuracyDashboardPage = lazy(() => import('@/pages/AccuracyDashboard'));
const ShadowReplayPage = lazy(() => import('@/pages/ShadowReplay'));
const BacktestingPortalPage = lazy(() => import('@/pages/BacktestingPortal'));
const BacktestResultsPage = lazy(() => import('@/pages/BacktestResults'));
const ForceSignalPage = lazy(() => import('@/pages/ForceSignal'));
const LiveAuditsPage = lazy(() => import('@/pages/LaunchAudit'));
const PaymentsPage = lazy(() => import('@/pages/Payments'));
const AdminLoginPage = lazy(() => import('@/pages/AdminLogin'));
const ModelMonitoringPage = lazy(() => import('@/pages/ModelMonitoring'))
const RecommendationCalibrationPage = lazy(() => import('@/pages/RecommendationCalibration'));
const AccountPage = lazy(() => import('@/pages/Account'));
const SupportPage = lazy(() => import('@/pages/SupportPage'));
const SupportTicketPage = lazy(() => import('@/pages/SupportTicketPage'));
const AdminSupportCenter = lazy(() => import('@/pages/AdminSupportCenter'));
const AdminUsersPage = lazy(() => import('@/pages/AdminUsers'));
const AdminParlayBuilder = lazy(() => import('@/pages/AdminParlayBuilder'));

const queryClient = new QueryClient();

// REQUIRED — resolves the publishable key from window.location.hostname so the same
// build serves multiple Clerk custom domains. Do not inline the env var directly.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — empty in dev (Clerk hits FAPI directly), auto-set in prod. Do NOT gate on NODE_ENV.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');

// Clerk passes full paths (including basePath) to routerPush/routerReplace; wouter's
// setLocation prepends the base automatically, so strip it to avoid double-prefixing.
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || '/'
    : path;
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: 'clerk',
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#00ff41',
    colorForeground: '#f0fff4',
    colorMutedForeground: '#a7c4ae',
    colorDanger: '#ff4444',
    colorBackground: '#060a07',
    colorInput: '#0e1810',
    colorInputForeground: '#f0fff4',
    colorNeutral: '#1e3a26',
    fontFamily: "'JetBrains Mono', monospace",
    borderRadius: '0.75rem',
  },
  elements: {
    rootBox: 'w-full flex justify-center',
    cardBox: 'bg-[#0b120d] border border-[#1e3a26] rounded-2xl w-[440px] max-w-full overflow-hidden',
    card: '!shadow-none !border-0 !bg-transparent !rounded-none',
    footer: '!shadow-none !border-0 !bg-transparent !rounded-none',
    headerTitle: 'text-[#f0fff4] font-mono font-bold tracking-tight',
    headerSubtitle: 'text-[#a7c4ae] font-mono text-sm',
    socialButtonsBlockButtonText: 'text-[#f0fff4] font-mono',
    formFieldLabel: 'text-[#a7c4ae] font-mono text-xs uppercase tracking-wider',
    footerActionLink: 'text-[#00ff41] font-mono',
    footerActionText: 'text-[#a7c4ae] font-mono',
    dividerText: 'text-[#a7c4ae] font-mono text-xs',
    identityPreviewEditButton: 'text-[#00ff41] font-mono',
    formFieldSuccessText: 'text-[#00ff41] font-mono text-xs',
    alertText: 'text-[#f0fff4] font-mono text-sm',
    logoBox: 'mb-2',
    logoImage: 'h-10 w-10',
    socialButtonsBlockButton: 'bg-[#0e1810] border border-[#1e3a26] hover:bg-[#1a2d1f]',
    formButtonPrimary: 'bg-[#00ff41] text-[#060a07] hover:bg-[#00cc66] font-mono font-bold uppercase tracking-widest',
    formFieldInput: 'bg-[#0e1810] border-[#1e3a26] text-[#f0fff4] font-mono',
    footerAction: 'bg-[#060a07] border-t border-[#1e3a26]',
    dividerLine: 'bg-[#1e3a26]',
    alert: 'bg-[#0e1810] border border-[#1e3a26]',
    otpCodeFieldInput: 'bg-[#0e1810] border-[#1e3a26] text-[#f0fff4] font-mono',
    formFieldRow: 'font-mono',
    main: 'font-mono',
  },
};

function SignInPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_top,_hsl(var(--primary)/0.06),_transparent_55%)] pointer-events-none" />

      {/* Back button — top-left */}
      <button
        onClick={() => { window.location.href = basePath || "/"; }}
        className="absolute top-4 left-4 flex items-center gap-1.5 px-3 py-2 rounded-lg border border-border/60 bg-secondary/50 text-muted-foreground hover:text-foreground hover:bg-secondary transition-all z-10 text-sm font-medium"
        aria-label="Go back"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6"/>
        </svg>
        Back
      </button>

      {/* Admin bypass — top-right corner */}
      <a
        href={`${basePath}/admin/login`}
        className="absolute top-4 right-4 p-2 rounded-lg border bg-amber-500/10 text-amber-400 border-amber-500/30 hover:bg-amber-500/20 hover:text-amber-300 hover:border-amber-500/50 transition-all z-10"
        title="Admin login — bypass user sign-in"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
          <path d="m9 12 2 2 4-4"/>
        </svg>
      </a>

      {/* path must be the full browser path — Clerk reads window.location.pathname directly */}
      <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} />
    </div>
  );
}

function SignUpPage() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4 relative">
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_45%_at_top,_hsl(var(--primary)/0.06),_transparent_55%)] pointer-events-none" />
      <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />
    </div>
  );
}

/** Gate a route behind Clerk auth. Redirects to /sign-in when signed-out.
 *  Admin (owner) session bypasses Clerk entirely — if the admin cookie is valid
 *  the route renders unconditionally, no Clerk account required. */
function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { isLoaded, userId } = useAuth();
  const { data: adminAuth } = useGetAdminAuthStatus();

  // Admin owner: bypass Clerk entirely
  if (adminAuth?.authenticated) return <Component />;

  // Clerk user: wait for Clerk to resolve, then check
  if (!isLoaded) return null;
  if (!userId) return <Redirect to="/sign-in" />;
  return <Component />;
}

/** Gate a route behind the admin session cookie. Redirects to /admin/login
 *  for any request that lacks a valid admin cookie — including signed-in Clerk
 *  users who are not the owner. Regular subscribers must never reach these pages. */
function AdminRoute({ component: Component }: { component: React.ComponentType }) {
  const { data: adminAuth, isLoading } = useGetAdminAuthStatus();
  if (isLoading) return null;
  if (!adminAuth?.authenticated) return <Redirect to="/admin/login" />;
  return <Component />;
}

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

// Invalidate the QueryClient cache when the signed-in user changes so stale
// per-user data doesn't bleed across sessions.
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsub = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (prevUserIdRef.current !== undefined && prevUserIdRef.current !== userId) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsub;
  }, [addListener, qc]);

  return null;
}

function Router() {
  return (
    <Switch>
      {/* Auth pages — outside Layout so they render full-screen */}
      {/* REQUIRED: exactly "/sign-in/*?" and "/sign-up/*?" — the /*? wildcard matches
          both the bare URL and Clerk's OAuth sub-paths (sso-callback, factor-one, etc.) */}
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />

      {/* All other routes share the Layout */}
      <Route>
        <Layout>
          <Suspense fallback={<PageFallback />}>
            <Switch>
              <Route path="/" component={Home} />
              {/* Protected: require Clerk sign-in */}
              <Route path="/predict">
                {() => <ProtectedRoute component={PredictBuilderPage} />}
              </Route>
              <Route path="/predictions/:id">
                {() => <ProtectedRoute component={PredictionResultView} />}
              </Route>
              <Route path="/history">
                {() => <ProtectedRoute component={HistoryPage} />}
              </Route>
              {/* Subscriber pages */}
              <Route path="/monitoring">
                {() => <ProtectedRoute component={ModelMonitoringPage} />}
              </Route>
              <Route path="/account">
                {() => <ProtectedRoute component={AccountPage} />}
              </Route>
              {/* Admin-only routes — require valid admin session cookie */}
              <Route path="/evaluation/log">
                {() => <AdminRoute component={PredictionLogPage} />}
              </Route>
              <Route path="/evaluation/dashboard">
                {() => <AdminRoute component={AccuracyDashboardPage} />}
              </Route>
              <Route path="/force-signal">
                {() => <AdminRoute component={ForceSignalPage} />}
              </Route>
              <Route path="/shadow-replay">
                {() => <AdminRoute component={ShadowReplayPage} />}
              </Route>
              <Route path="/backtesting/:id">
                {() => <AdminRoute component={BacktestResultsPage} />}
              </Route>
              <Route path="/backtesting">
                {() => <AdminRoute component={BacktestingPortalPage} />}
              </Route>
              <Route path="/launch-audit">
                {() => <AdminRoute component={LiveAuditsPage} />}
              </Route>
              <Route path="/admin/recommendation-calibration">
                {() => <AdminRoute component={RecommendationCalibrationPage} />}
              </Route>
              <Route path="/admin/support">
                {() => <AdminRoute component={AdminSupportCenter} />}
              </Route>
              <Route path="/admin/users">
                {() => <AdminRoute component={AdminUsersPage} />}
              </Route>
              <Route path="/admin/parlay-builder">
                {() => <AdminRoute component={AdminParlayBuilder} />}
              </Route>
              <Route path="/support/tickets/:id">
                {() => <ProtectedRoute component={SupportTicketPage} />}
              </Route>
              <Route path="/support">
                {() => <ProtectedRoute component={SupportPage} />}
              </Route>
              <Route path="/payments" component={PaymentsPage} />
              <Route path="/payments/pricing" component={PaymentsPage} />
              <Route path="/payments/billing" component={PaymentsPage} />
              <Route path="/payments/admin" component={PaymentsPage} />
              <Route path="/admin/login" component={AdminLoginPage} />
              <Route component={NotFound} />
            </Switch>
          </Suspense>
        </Layout>
      </Route>
    </Switch>
  );
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: 'Welcome back',
            subtitle: 'Sign in to Tennis Matrix AI',
          },
        },
        signUp: {
          start: {
            title: 'Create your account',
            subtitle: 'Get started with Tennis Matrix AI',
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <TooltipProvider>
          <Router />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      themes={['light', 'dark']}
    >
      {/* WouterRouter must wrap ClerkProvider so routerPush can call useLocation */}
      <WouterRouter base={basePath}>
        <ErrorBoundary>
          <ClerkProviderWithRoutes />
        </ErrorBoundary>
      </WouterRouter>
    </ThemeProvider>
  );
}

export default App;
