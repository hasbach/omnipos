import fs from "fs";
import path from "path";
import crypto from "crypto";

// OmniPOS ships as a downloadable desktop installer, not a server a technical operator
// configures — there's no realistic way to require an end user to set an environment variable
// before first run, and the packaged build doesn't even carry a .env file (see .gitignore /
// electron-builder's "files" list). Failing to start without SESSION_SECRET, the fix that makes
// sense for a hosted server, would just break the app for every real customer.
//
// So the session-signing secret is generated once per machine, the first time the server runs
// without an explicit SESSION_SECRET, and cached locally so every later start reuses the SAME
// value (otherwise every restart would invalidate every open session, forcing everyone to
// re-login). This closes "the same hardcoded secret ships in every install" without requiring
// any configuration — an explicit SESSION_SECRET env var (e.g. for a self-hosted deployment)
// still always wins.
const dataDir = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Application Support') : path.join(process.env.HOME || '', '.config'));
const appDataDir = path.join(dataDir, 'OmniPOS');
const SECRETS_PATH = path.join(appDataDir, 'secrets.json');

function readGeneratedSecrets(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeGeneratedSecrets(secrets: Record<string, string>): void {
  try {
    if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });
    // mode 0o600: readable/writable only by whoever's running the app, same as any other
    // per-user secret file (SSH keys, etc.) — nothing else on the machine should read this.
    fs.writeFileSync(SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
  } catch (e) {
    console.error('Failed to persist generated secret:', e);
  }
}

export function getOrCreateSessionSecret(): string {
  const fromEnv = process.env.SESSION_SECRET;
  if (fromEnv) return fromEnv;

  const secrets = readGeneratedSecrets();
  if (secrets.sessionSecret) return secrets.sessionSecret;

  const generated = crypto.randomBytes(32).toString('hex');
  secrets.sessionSecret = generated;
  writeGeneratedSecrets(secrets);
  return generated;
}
