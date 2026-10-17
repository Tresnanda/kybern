import type { ComponentType } from 'react'
import { sections as hello } from './hello'
export const sections: Record<string, ComponentType> = { ...hello }
