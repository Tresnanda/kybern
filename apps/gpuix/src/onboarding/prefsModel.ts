// What a material option does to a saved variant, with the same rules Settings uses (`settings/appearance.ts`
// `resolveMaterialPatch`, then the normalizer), so the preview and the written values agree.
import { resolveMaterialPatch } from '../settings/appearance.ts'
import { normalizeVariantMaterial, type VariantMaterial } from '../platform/translucency.ts'

export function applyMaterialPatch(current: VariantMaterial, patch: Partial<VariantMaterial>): VariantMaterial {
  return normalizeVariantMaterial({ ...current, ...resolveMaterialPatch(current, patch) })
}
