// PR row geometry remains live for selection/search/hitboxes. The viewport
// island also keeps unrelated PR headers and lists out of a scroll frame.
// Structural spread avoids replacing the upstream VirtualListShared alias.
export const PR_SCROLL_LAYOUT = {
 cacheLayout: true,
 ...(process.env.KYBERN_SCROLL_ISLANDS !== '0' ? { cache: 'fill' as const } : {}),
} as const
