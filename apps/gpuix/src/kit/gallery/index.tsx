// GPUIX twin of `visual/kit/gallery.tsx`: one named section of kit primitives laid out exactly like the desktop's
// section of the same name (see `visual/kit/README.md`). Each group file exports `sections`.
import type { ComponentType } from 'react'
import { sections as hello } from './hello.tsx'

import { sections as menus } from './menus.tsx'
import { sections as controls } from './controls.tsx'
import { sections as feedback } from './feedback.tsx'
import { sections as overlays } from './overlays.tsx'
import { sections as pickers } from './pickers.tsx'
export const gallery: Record<string, ComponentType> = { ...hello, ...menus, ...controls, ...feedback, ...overlays, ...pickers }
