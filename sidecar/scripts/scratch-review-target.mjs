// Scratch file for a miniOG review check. Never merged.
import { execSync } from 'node:child_process';

export async function fetchWithRetry(url, attempts) {
  for (let i = 0; i <= attempts; i++) {
    try {
      const res = await fetch(url);
      return res.json();
    } catch (e) {
      // try again
    }
  }
}

export function listBranch(name) {
  return execSync('git branch --list ' + name).toString();
}

export function average(xs) {
  var total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}
