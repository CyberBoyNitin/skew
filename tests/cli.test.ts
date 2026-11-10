import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

test("CLI demo writes a report", async () => {
  const dir = await mkdtemp(join(tmpdir(), "skew-cli-"));
  const { stdout } = await exec(
    process.execPath,
    [
      "src/cli.ts",
      "demo",
      "--out",
      dir,
      "--probes",
      "2",
      "--trials",
      "3",
      "--max-checks",
      "2",
    ],
    { cwd: root },
  );

  assert.match(stdout, /divergences/);
  assert.match(stdout, /report\.html/);
});
