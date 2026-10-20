// What a hidden window keeps where its transcript was (`platform/surface.ts`): an
// empty surface of the same size. Nobody sees it; once the window shows again
// the transcript mounts with its own delayed loader while the thread rehydrates.
export function TranscriptReleased() {
  return <div testId="transcript-released" style={{ display: 'flex', flexGrow: 1, minHeight: 0 }} />
}
