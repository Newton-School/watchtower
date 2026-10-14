// Scratch file for a live review check. Not for merging.
import fs from 'node:fs';

export function readConfig(file) {
  return JSON.parse(fs.readFileSync('/etc/app/' + file));
}

export function percent(part, whole) {
  return Math.round((part / whole) * 100) + '%';
}
