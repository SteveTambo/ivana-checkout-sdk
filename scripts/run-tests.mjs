// Runs every test/*.test.js with Node's test runner. The files are listed
// here rather than passed as a glob because Node 18 and 20 don't expand
// "test/*.test.js" themselves, and `node --test test/` stopped working as a
// directory argument in newer Node. Extra arguments (the coverage flags) are
// passed through to node.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const files = readdirSync(join(root, "test"))
  .filter((name) => name.endsWith(".test.js"))
  .sort()
  .map((name) => join("test", name));

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
