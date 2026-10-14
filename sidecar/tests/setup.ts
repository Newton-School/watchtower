import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __connectors } from '../src/backends/connectors.js';

// No test reads the developer's own Claude config. Which connectors a host has
// decides what an agent is given and told (issue #443), so it has to come from
// the test: with the real home, a prompt differed from one machine to the next.
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'watchtower-test-home-'));
__connectors.home = () => emptyHome;
