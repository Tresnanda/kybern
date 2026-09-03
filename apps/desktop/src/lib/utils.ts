import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isMacNavigatorPlatform(): boolean {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform
  return /mac|darwin|iphone|ipad|ipod/i.test(platform)
}
