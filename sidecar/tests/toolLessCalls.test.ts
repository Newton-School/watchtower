import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #443: calls that only turn text into text (intent, repo and scope
// classifiers, approval intent, synthesizers) ran with every tool, MCP
// connector and skill of the host user, while reading arbitrary Slack text.
// They all run in a temp directory, which is what makes them findable here.
// A new one added without `noTools` fails this test.
const SRC = path.resolve(import.meta.dirname, '../src');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') ? [full] : [];
  });
}

describe('text-only agent calls', () => {
  const sites = sourceFiles(SRC).flatMap(file => {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    return lines.flatMap((line, index) =>
      line.trim() === 'cwd: os.tmpdir(),'
        ? [{ where: `${path.relative(SRC, file)}:${index + 1}`, next: (lines[index + 1] ?? '').trim() }]
        : [],
    );
  });

  it('finds the calls it is meant to guard', () => {
    expect(sites.length).toBeGreaterThanOrEqual(9);
  });

  it.each(sites)('$where runs without tools', ({ next }) => {
    expect(next).toBe('noTools: true,');
  });
});
