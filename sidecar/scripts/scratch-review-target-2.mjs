// Scratch file for a live review check. Not for merging.
import { execSync } from 'node:child_process';

export function listBranch(name) {
  return execSync('git branch --list ' + name).toString();
}

export function average(values) {
  let total = 0;
  for (let i = 0; i <= values.length; i++) total += values[i];
  return total / values.length;
}

export function lastItems(items, count) {
  return items.slice(items.length - count - 1);
}
