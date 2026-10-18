// Scratch file for a live restart-recovery check. Not for merging.
export function ratio(done, total) {
  return Math.round((done / total) * 100);
}

export function firstWord(text) {
  return text.split(' ')[0].toUpperCase();
}
