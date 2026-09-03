import { Component, type ReactNode } from "react"

import { Button } from "@/components/synara/button"

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-[14px] font-medium">Something went wrong in {this.props.label ?? "this view"}</p>
        <pre className="selectable max-w-xl overflow-auto rounded-lg bg-muted px-3 py-2 text-start text-[12px] text-muted-foreground">
          {this.state.error.message}
          {"\n"}
          {this.state.error.stack?.split("\n").slice(1, 6).join("\n")}
        </pre>
        <Button size="sm" variant="secondary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
