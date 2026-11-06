// An error boundary per surface (`components/kybern/ErrorBoundary.tsx`): a
// render error inside the sidebar, the page, the transcript or the composer
// shows a readable fallback in that place and leaves the rest of the window
// working. The fallback names the surface, shows the error and offers Reload,
// which remounts the surface's tree from scratch.
import { errorMessage } from '../../../../packages/kybern-client/src/problem.ts'
import { ProblemRow } from '../kit/Problem.tsx'
import { Component, Fragment, type ReactNode } from 'react'

interface State {
  error: Error | null
  /** Bumped by Reload: the children remount instead of re-rendering into the same bug. */
  attempt: number
}

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string; compact?: boolean }, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error) {
    console.error(`[error-boundary] ${this.props.label ?? 'view'}:`, error)
  }

  render() {
    if (!this.state.error) return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>
    return <Fallback label={this.props.label ?? 'this view'} error={this.state.error} compact={this.props.compact} onReload={() => this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))} />
  }
}

function Fallback({ label, error, compact, onReload }: { label: string; error: Error; compact?: boolean; onReload: () => void }) {
  const stack = error.stack?.split('\n').slice(1, 4).join('\n')
  // The message and stack are for whoever reports the bug: behind "Show details", never the headline.
  return (
    <div testId="error-fallback" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: compact ? 12 : 32 }}>
      <div style={{ width: '100%', maxWidth: 520 }}>
        <ProblemRow
          title={`Something went wrong in ${label}`}
          body="The rest of the window keeps working. Reload to try again."
          primary={{ label: 'Reload', onClick: onReload, testId: 'error-reload' }}
          detail={[errorMessage(error), !compact && stack].filter(Boolean).join('\n')}
          testId="error-problem"
        />
      </div>
    </div>
  )
}
