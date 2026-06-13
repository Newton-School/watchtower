#!/usr/bin/env node
// Bump the app version across all four version files, branch off the latest
// origin/main, commit, push, open a PR, and (optionally) squash-merge it.
//
// Usage:
//   node scripts/bump-version.mjs [patch|minor|major|X.Y.Z] [--merge] [--dry-run] [--no-pr] [--no-push]
//
//   patch (default)  0.6.62 -> 0.6.63
//   minor            0.6.62 -> 0.7.0
//   major            0.6.62 -> 1.0.0
//   X.Y.Z            explicit target version
//
//   --dry-run   compute + validate the four edits and print the plan; touch nothing.
//   --merge     after opening the PR, squash-merge it, delete the branch, return to main, pull.
//   --no-pr     edit + commit + push the branch, but don't open a PR.
//   --no-push   edit + commit only (local branch).
//
// The bump branch is always based on the latest origin/main, so it's correct
// regardless of which branch you're on — but it aborts if you have uncommitted
// changes to tracked files (so nothing in progress is lost).

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cap = cmd => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const run = cmd => {
  console.log(`$ ${cmd}`);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
};
const die = msg => {
  console.error(`✗ ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const bumpArg = args.find(a => !a.startsWith('--')) ?? 'patch';
const dryRun = flags.has('--dry-run');
const doMerge = flags.has('--merge');
const noPr = flags.has('--no-pr');
const noPush = flags.has('--no-push');

// Always base the version off the latest origin/main, not whatever is checked out.
run('git fetch origin --quiet');
const pkgOnMain = cap('git show origin/main:package.json');
const cur = pkgOnMain.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/);
if (!cur) die('could not read "version" from origin/main:package.json');
const [major, minor, patch] = cur.slice(1, 4).map(Number);
const current = `${major}.${minor}.${patch}`;

let next;
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg;
else if (bumpArg === 'patch') next = `${major}.${minor}.${patch + 1}`;
else if (bumpArg === 'minor') next = `${major}.${minor + 1}.0`;
else if (bumpArg === 'major') next = `${major + 1}.0.0`;
else die(`unknown bump arg "${bumpArg}" (use patch|minor|major|X.Y.Z)`);

if (next === current) die(`target version ${next} equals current ${current}`);

const branch = `chore/bump-v${next}`;

// The four edits. JSON files key on the `"version"` line; the Rust files key on
// the watchtower package block so dependency versions are never touched.
const edits = [
  { file: 'package.json', find: `"version": "${current}"`, repl: `"version": "${next}"` },
  { file: 'src-tauri/tauri.conf.json', find: `"version": "${current}"`, repl: `"version": "${next}"` },
  {
    file: 'src-tauri/Cargo.toml',
    find: `name = "watchtower"\nversion = "${current}"`,
    repl: `name = "watchtower"\nversion = "${next}"`,
  },
  {
    file: 'src-tauri/Cargo.lock',
    find: `name = "watchtower"\nversion = "${current}"`,
    repl: `name = "watchtower"\nversion = "${next}"`,
  },
];

// Validate every edit matches exactly once against origin/main BEFORE writing
// anything, so a stale pattern can never produce a partial bump.
for (const e of edits) {
  const blob = cap(`git show origin/main:${e.file}`);
  const count = blob.split(e.find).length - 1;
  if (count !== 1) die(`expected exactly 1 match for ${JSON.stringify(e.find)} in ${e.file}, found ${count}`);
}

console.log(`\nBump ${current} → ${next}  (branch ${branch})`);
console.log(`Files: ${edits.map(e => e.file).join(', ')}`);

if (dryRun) {
  console.log('\n[dry-run] validated all four edits against origin/main. Nothing written.');
  process.exit(0);
}

// Don't clobber in-progress work.
if (cap('git status --porcelain --untracked-files=no')) {
  die('working tree has uncommitted changes to tracked files — commit or stash first');
}

run(`git checkout -B ${branch} origin/main`);
for (const e of edits) {
  const p = resolve(ROOT, e.file);
  writeFileSync(p, readFileSync(p, 'utf8').replace(e.find, e.repl));
}
run(`git add ${edits.map(e => e.file).join(' ')}`);
run(`git commit -m "chore: bump version to ${next}"`);

if (noPush) {
  console.log(`\n✓ Committed ${next} on ${branch} (not pushed).`);
  process.exit(0);
}
run(`git push -u origin ${branch}`);

if (noPr) {
  console.log(`\n✓ Pushed ${branch} (no PR opened).`);
  process.exit(0);
}

const prUrl = cap(
  `gh pr create --base main --head ${branch} ` +
    `--title "chore: bump version to ${next}" ` +
    `--body "Automated version bump ${current} → ${next} via scripts/bump-version.mjs."`,
);
console.log(`\n✓ PR: ${prUrl}`);

if (doMerge) {
  run(`gh pr merge ${branch} --squash --delete-branch`);
  run('git checkout main');
  run('git pull --ff-only');
  console.log(`\n✓ Merged & synced main to ${next}.`);
}
