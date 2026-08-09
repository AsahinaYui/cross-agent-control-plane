import assert from "node:assert/strict";
import test from "node:test";
import { runCommand } from "../process.mjs";

test("non-interactive commands receive stdin EOF", async () => {
  const result = await runCommand({
    argv: [
      process.execPath,
      "-e",
      "process.stdin.on('end',()=>process.stdout.write('closed'));process.stdin.resume()",
    ],
    timeoutMs: 2_000,
  });
  assert.equal(result.timed_out, false);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, "closed");
});
