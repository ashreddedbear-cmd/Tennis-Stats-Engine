import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, lazy } from 'react';
import { ThemeProvider } from 'next-themes';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import NotFound from '@/pages/not-found';
import { Route, Switch, Router as WouterRouter } from 'wouter';
import { Layout } from '@/components/Layout';
import Home from '@/pages/Home';
import PredictBuilderPage from '@/pages/PredictBuilder';
import HistoryPage from '@/pages/History';
import PredictionLogPage from '@/pages/PredictionLog';

// Lazy-loaded because they pull in recharts (a large charting library) -- keeping them out of
// the main bundle means the home/predict-builder flow (the common path) doesn't pay for a chart
// library it never renders.
const PredictionResultView = lazy(() => import('@/pages/PredictionResultView'));
const AccuracyDashboardPage = lazy(() => import('@/pages/AccuracyDashboard'));
const ShadowReplayPage = lazy(() => import('@/pages/ShadowReplay'));
const BacktestingPortalPage = lazy(() => import('@/pages/BacktestingPortal'));
const BacktestResultsPage = lazy(() => import('@/pages/BacktestResults'));
const ForceSignalPage = lazy(() => import('@/pages/ForceSignal'));
const LaunchAuditPage = lazy(() => import('@/pages/LaunchAudit'));
const PaymentsPage = lazy(() => import('@/pages/Payments'));
const AdminLoginPage = lazy(() => import('@/pages/AdminLogin'));
const TermsOfServicePage = lazy(() => import('@/pages/TermsOfService'));
const PrivacyPolicyPage = lazy(() => import('@/pages/PrivacyPolicy'));
const ResponsibleGamblingPage = lazy(() => import('@/pages/ResponsibleGambling'));

const queryClient = new QueryClient();

function PageFallback() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

function Router() {
  return (
    <Layout>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/" component={Home} />
          <Route path="/predict" component={PredictBuilderPage} />
          <Route path="/predictions/:id" component={PredictionResultView} />
          <Route path="/history" component={HistoryPage} />
          <Route path="/evaluation/log" component={PredictionLogPage} />
          <Route path="/evaluation/dashboard" component={AccuracyDashboardPage} />
          <Route path="/force-signal" component={ForceSignalPage} />
          <Route path="/shadow-replay" component={ShadowReplayPage} />
          <Route path="/backtesting/:id" component={BacktestResultsPage} />
          <Route path="/backtesting" component={BacktestingPortalPage} />
          <Route path="/launch-audit" component={LaunchAuditPage} />
          <Route path="/payments" component={PaymentsPage} />
          <Route path="/payments/pricing" component={PaymentsPage} />
          <Route path="/payments/billing" component={PaymentsPage} />
          <Route path="/payments/admin" component={PaymentsPage} />
          <Route path="/admin/login" component={AdminLoginPage} />
          <Route path="/terms" component={TermsOfServicePage} />
          <Route path="/privacy" component={PrivacyPolicyPage} />
          <Route path="/responsible-gambling" component={ResponsibleGamblingPage} />
          <Route path="/disclaimer" component={ResponsibleGamblingPage} />
          <Route component={NotFound} />
        </Switch>
      </Suspense>
    </Layout>
  );
}

function App() {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      themes={["light", "dark"]}
    >
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
            <Router />
          </WouterRouter>
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default App;
