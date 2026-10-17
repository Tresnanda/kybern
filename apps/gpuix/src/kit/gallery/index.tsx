// GPUIX twin of `visual/kit/gallery.tsx`: one named section of kit primitives laid out exactly like the desktop's
// section of the same name (see `visual/kit/README.md`). Each group file exports `sections`.
import type { ComponentType } from 'react'
import { sections as hello } from './hello.tsx'

export const gallery: Record<string, ComponentType> = { ...hello }
