#!/usr/bin/env node
// Runs the regression suite under plain Node, which means better-sqlite3 has to be built for
// Node's ABI first (the rest of the app runs it under Electron's ABI instead — see the
// "rebuild" script and the project's local-run notes). This wrapper handles that switch
// automatically: rebuild for Node -> run the tests -> restore the Electron build, regardless of
// whether the tests passed, so a failed test run never leaves better-sqlite3 in the wrong ABI for
// the next `npx electron .`/packaging step.
import { spawnSync } from "child_process";
import { readdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.join(__dirname, "..", "tests");
const testFiles = readdirSync(testsDir)
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => path.join("tests", f));

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  return result.status ?? 1;
}

console.log("--- Rebuilding better-sqlite3 for Node (tests run outside Electron) ---");
const rebuildForNode = run("npm", ["rebuild", "better-sqlite3"]);
if (rebuildForNode !== 0) {
  console.error("Failed to rebuild better-sqlite3 for Node — aborting before running any tests.");
  process.exit(rebuildForNode);
}

console.log(`--- Running ${testFiles.length} test file(s) ---`);
const testExitCode = run("npx", ["tsx", "--test", ...testFiles]);

console.log("--- Restoring better-sqlite3 for Electron ---");
const rebuildForElectron = run("npm", ["run", "rebuild"]);
if (rebuildForElectron !== 0) {
  console.error(
    'WARNING: failed to restore the Electron build of better-sqlite3. Run "npm run rebuild" manually before using the Electron app.'
  );
}

process.exit(testExitCode);
