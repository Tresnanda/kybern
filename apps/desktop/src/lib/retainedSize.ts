// Conservative retained-data estimate, not JavaScript heap or RSS. Immutable
// subtrees are counted once per measurement and cached weakly across updates.
const sizes = new WeakMap<object, number>()
export function retainedSize(value: unknown): number {
  if (typeof value === "string") return 16 + value.length * 2
  if (!value || typeof value !== "object") return 8
  const cached = sizes.get(value)
  if (cached !== undefined) return cached
  let bytes = 48
  for (const [key, child] of Object.entries(value)) bytes += 16 + key.length * 2 + retainedSize(child)
  sizes.set(value, bytes)
  return bytes
}
