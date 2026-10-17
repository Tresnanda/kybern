import type { ComponentType } from 'react'
import { sections as hello } from './hello'
import { sections as menus } from './menus'
import { sections as overlays } from './overlays'
import { sections as pickers } from './pickers'
import { sections as controls } from './controls'
import { sections as feedback } from './feedback'
export const sections: Record<string, ComponentType> = { ...hello, ...menus, ...overlays, ...pickers, ...controls, ...feedback }
