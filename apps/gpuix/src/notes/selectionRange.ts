export function markRange(value: string, start: number, end: number, marker: string) {
  // Block separators are source structure, not part of an inline mark.
  if (end > start) end -= (value.slice(start, end).match(/\s+$/)?.[0].length ?? 0)
  const selected = value.slice(start, end)
  if (start >= marker.length && value.slice(start - marker.length, start) === marker && value.slice(end, end + marker.length) === marker)
    return { start: start - marker.length, end: end + marker.length, text: selected, selectionStart: start - marker.length, selectionEnd: end - marker.length }
  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker))
    return { start, end, text: selected.slice(marker.length, -marker.length), selectionStart: start, selectionEnd: end - marker.length * 2 }
  return { start, end, text: marker + selected + marker, selectionStart: start + marker.length, selectionEnd: end + marker.length }
}

