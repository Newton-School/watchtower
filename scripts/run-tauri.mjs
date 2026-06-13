import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { homedir } from 'node:os';

const env = { ...process.env };

// Stable code signing for macOS so TCC permission grants (e.g. the Documents
// prompt) PERSIST across installs instead of resetting every build. An ad-hoc
// signature has no stable identity — macOS keys the grant on the binary's
// cdhash, which changes every rebuild, so each install looks like a new app.
//
// We auto-detect a code-signing identity in the keychain (a free self-signed
// "Watchtower Self-Signed" cert is enough — no Apple Developer account needed;
// override the name with WATCHTOWER_SIGN_IDENTITY) and hand it to Tauri via
// APPLE_SIGNING_IDENTITY. If no such identity exists we leave signing alone:
// the build still produces an ad-hoc app exactly as before, so nothing breaks
// before the cert is created.
if (process.platform === 'darwin' && !env.APPLE_SIGNING_IDENTITY) {
  const wanted = env.WATCHTOWER_SIGN_IDENTITY || 'Watchtower Self-Signed';
  try {
    const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
    });
    // Lines look like:  1) <SHA1> "Watchtower Self-Signed"
    const match = identities.split('\n').find(line => line.includes(`"${wanted}"`));
    if (match) {
      env.APPLE_SIGNING_IDENTITY = wanted;
      console.log(`[run-tauri] signing with stable identity "${wanted}" (TCC grants will persist)`);
    } else {
      console.log(
        `[run-tauri] no "${wanted}" code-signing identity found — building ad-hoc. ` +
          `Create one in Keychain Access (Certificate Assistant → Create a Certificate, type "Code Signing") ` +
          `to make macOS permission grants persist across installs.`,
      );
    }
  } catch {
    // `security` unavailable or errored — fall back to ad-hoc silently.
  }
}
const home = env.HOME || env.USERPROFILE || homedir();
const isWindows = process.platform === 'win32';
const cargoExe = isWindows ? 'cargo.exe' : 'cargo';
const tauriCmd = isWindows ? 'tauri.cmd' : 'tauri';

const candidateDirs = [join(home, '.cargo', 'bin'), env.CARGO_HOME ? join(env.CARGO_HOME, 'bin') : ''].filter(Boolean);
const currentPath = env.PATH || '';
for (const dir of candidateDirs) {
  if (!currentPath.split(delimiter).includes(dir)) {
    env.PATH = `${dir}${delimiter}${env.PATH || ''}`;
  }
}

if (!env.CARGO) {
  for (const dir of candidateDirs) {
    const candidate = join(dir, cargoExe);
    if (existsSync(candidate)) {
      env.CARGO = candidate;
      break;
    }
  }
}

const args = process.argv.slice(2);
const child = spawn(tauriCmd, args, {
  stdio: 'inherit',
  env,
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});

child.on('error', error => {
  console.error(error.message);
  process.exit(1);
});
