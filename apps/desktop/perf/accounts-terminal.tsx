// Sign-in stays entirely inside this fixture; no shell, xterm, or credentials.
export function TerminalInstance({ onExit }: { onExit: () => void }) {
  return <div data-account-sign-in className="h-full bg-background p-4 text-sm text-foreground">
    <p>Fixture native sign-in terminal</p>
    <p className="mt-2 text-muted-foreground">No credentials or real agent processes are used.</p>
    <button className="mt-4 underline" onClick={onExit}>Finish fixture sign-in</button>
  </div>
}
