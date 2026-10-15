/** Packaging gate: never call UNUserNotificationCenter from unbundled Bun;
 * macOS aborts inside dispatch_once before an Objective-C catch can recover. */
export type NotificationStatus = 'unsupported'
export interface NativeNotification { id: string; title: string; body: string }
const requirement = 'OS notifications require a macOS app bundle with a stable CFBundleIdentifier and a UNUserNotificationCenter delegate bridge; the unbundled Bun host cannot deliver them'
export const notifications = {
  async status(): Promise<NotificationStatus> { return 'unsupported' },
  async requestPermission(): Promise<never> { throw Error(requirement) },
  async post(_notification: NativeNotification): Promise<never> { throw Error(requirement) },
  onClick(_callback: (id: string) => void): never { throw Error(requirement) },
}
