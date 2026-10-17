// An error boundary per surface (`components/kybern/ErrorBoundary.tsx`): a
// render error inside the sidebar, the page, the transcript or the composer
// shows a readable fallback in that place and leaves the rest of the window
// working. The fallback names the surface, shows the error and offers Reload,
// which remounts the surface's tree from scratch.
import { Component, Fragment, type ReactNode } from 'react'
import { Label, useTheme } from '../ui.tsx'

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
  const t = useTheme()
  const stack = error.stack?.split('\n').slice(1, 4).join('\n')
  return (
    <div
      testId="error-fallback"
      style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: compact ? 12 : 32 }}
    >
      <Label color={t.text} size={14} weight={500}>
        {`Something went wrong in ${label}`}
      </Label>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxWidth: 520, paddingLeft: 12, paddingRight: 12, paddingTop: 8, paddingBottom: 8, borderRadius: 10, backgroundColor: t.buttonSecondary }}>
        <Label color={t.textSecondary} size={12} lineHeight={16}>
          {error.message}
        </Label>
        {stack && !compact && (
          <Label color={t.textTertiary} size={11} lineHeight={15}>
            {stack}
          </Label>
        )}
      </div>
      <div
        testId="error-reload"
        role="button"
        onClick={onReload}
        style={{
          display: 'flex',
          alignItems: 'center',
          height: 28,
          paddingLeft: 12,
          paddingRight: 12,
          borderRadius: 10,
          backgroundColor: t.buttonSecondary,
          cursor: 'pointer',
          hover: { backgroundColor: t.buttonSecondaryHover },
          active: { opacity: 0.8 },
        }}
      >
        <Label color={t.text} size={13} weight={500}>
          Reload
        </Label>
      </div>
    </div>
  )
}
