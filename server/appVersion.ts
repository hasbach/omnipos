// The version of the running app, from package.json (the same number electron-updater compares against
// the GitHub release feed). Read at runtime relative to this module: server/ in development and tests,
// dist-server/ (inside app.asar) when packaged - both one level below package.json.
import { createRequire } from "module";

function readVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)("../package.json");
    if (pkg && typeof pkg.version === "string" && pkg.version) return pkg.version;
  } catch {
    /* fall through */
  }
  return process.env.npm_package_version || "0.0.0";
}

export const APP_VERSION = readVersion();
