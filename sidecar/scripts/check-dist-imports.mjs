// Loads every compiled module in plain Node, the way the app runs the sidecar.
// Vitest's module interop accepts imports that Node's ESM loader rejects (a
// named import Node can't find in a CommonJS package), and those crash the
// sidecar the moment it starts, as 0.6.173 did. The entry point is left out:
// importing it starts the sidecar.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dist = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const entry = path.join(dist, 'index.js');

function modules(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) return modules(full);
    return item.name.endsWith('.js') && full !== entry ? [full] : [];
  });
}

const failures = [];
const files = modules(dist);
for (const file of files) {
  try {
    await import(pathToFileURL(file).href);
  } catch (error) {
    failures.push(
      `${path.relative(dist, file)}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
    );
  }
}
if (failures.length > 0) {
  console.error(`${failures.length} of ${files.length} compiled modules fail to load in Node:\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`All ${files.length} compiled modules load in Node.`);
// Some modules start timers when loaded; don't wait on them.
process.exit(0);
