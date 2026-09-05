// The remote flows use the kit surfaces and user-adjustable type scale.
export const ENVIRONMENT_DIALOG =
  "max-w-lg [&_[data-slot=dialog-title]]:pe-6 [&_[data-slot=dialog-title]]:font-sans [&_[data-slot=dialog-title]]:text-[length:var(--app-font-size-ui-lg,16px)] [&_[data-slot=dialog-title]]:text-balance [&_[data-slot=dialog-description]]:text-[length:var(--app-font-size-ui,14px)] [&_[data-slot=dialog-description]]:leading-relaxed [&_[data-slot=dialog-description]]:text-pretty [&_[data-slot=dialog-description]]:break-words [&_[data-slot=button]]:active:scale-[0.96] motion-reduce:[&_[data-slot=button]]:active:scale-100"
export const ENVIRONMENT_HINT =
  "text-[length:var(--app-font-size-ui-sm,13px)] leading-relaxed text-pretty text-muted-foreground"
export const ENVIRONMENT_ERROR =
  "break-words text-[length:var(--app-font-size-ui-sm,13px)] leading-relaxed text-destructive"
