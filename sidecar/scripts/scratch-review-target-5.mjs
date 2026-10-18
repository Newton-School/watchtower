// Scratch file for a live pending-review check. Not for merging.
export function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function lastItem(items) {
  return items[items.length];
}
