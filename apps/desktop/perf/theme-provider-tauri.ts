export const vibrancyCalls: boolean[] = []

export const isTauri = () => true
export async function setWindowVibrancy(enabled: boolean) {
  vibrancyCalls.push(enabled)
}
