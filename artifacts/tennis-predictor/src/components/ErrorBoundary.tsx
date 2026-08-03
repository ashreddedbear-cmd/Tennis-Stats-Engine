import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface Props {
  children: ReactNode;
  /** Optional custom fallback UI. Receives error + reset fn. */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Global React error boundary.
 *
 * Catches uncaught render/lifecycle errors anywhere in the subtree and shows
 * a recovery screen instead of a blank page. All errors are also logged to the
 * browser console for debugging.
 *
 * Usage (wrap the router in App.tsx):
 *   <ErrorBoundary>
 *     <Router />
 *   </ErrorBoundary>
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log full stack + component tree for debugging
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
  }

  reset = () => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background px-4">
        <div className="max-w-md w-full space-y-6 text-center">
          {/* Matrix-style error icon */}
          <div className="flex justify-center">
            <div className="w-16 h-16 rounded-full bg-destructive/10 border border-destructive/30 flex items-center justify-center">
              <AlertTriangle className="w-8 h-8 text-destructive" />
            </div>
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-mono font-bold text-foreground tracking-tight uppercase">
              Unexpected Error
            </h1>
            <p className="text-sm text-muted-foreground font-mono">
              Something went wrong rendering this page. The error has been logged.
            </p>
          </div>

          {/* Show the error message in dev mode */}
          {import.meta.env.DEV && (
            <div className="text-left bg-muted/30 border border-border rounded-lg p-3 overflow-auto max-h-40">
              <p className="text-xs font-mono text-destructive break-all">
                {error.message}
              </p>
              {error.stack && (
                <pre className="text-xs font-mono text-muted-foreground mt-2 whitespace-pre-wrap break-all">
                  {error.stack.split('\n').slice(1, 6).join('\n')}
                </pre>
              )}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Button
              onClick={this.reset}
              variant="outline"
              className="font-mono uppercase tracking-widest text-xs"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Try Again
            </Button>
            <Button
              onClick={() => (window.location.href = '/')}
              className="font-mono uppercase tracking-widest text-xs"
            >
              Go to Dashboard
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
