import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const mode = args[args.indexOf("--mode") + 1] ?? "success";
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
emit({
  type: "model.observed",
  data: {
    runtime: { actual_model: "deterministic-fake-v1" },
    provider: { requested_route: "local:test" },
  },
});
emit({
  type: "agent.message",
  data: { channel: "progress", message: "Fake worker started" },
});
if (mode === "hang")
  setInterval(
    () =>
      emit({
        type: "agent.message",
        data: { channel: "progress", message: "still running" },
      }),
    250,
  );
else if (mode === "malformed") {
  process.stdout.write("not-json\n");
  process.exit(0);
} else if (mode === "denied") {
  emit({ type: "result", status: "denied", credible_terminal: true });
  process.exit(0);
} else if (mode === "nonzero") {
  emit({ type: "result", status: "failed", credible_terminal: true });
  process.exit(7);
} else if (mode === "scope-violation") {
  writeFileSync("outside.txt", "fixture\n", "utf8");
  emit({ type: "result", status: "completed", credible_terminal: true });
  process.exit(0);
} else {
  emit({
    type: "result",
    status: "completed",
    credible_terminal: true,
    summary: "Fake worker completed",
  });
  process.exit(0);
}
