import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "../process.mjs";

export const tempDir=(name)=>mkdtempSync(join(tmpdir(),`${name}-`));
export async function createGitFixture(name="repo with \u7a7a\u683c") {
  const root=tempDir(name); await runCommand({argv:["git","init","-b","main",root],cwd:tmpdir()});
  await runCommand({argv:["git","-C",root,"config","user.email","fixture@example.invalid"],cwd:root});
  await runCommand({argv:["git","-C",root,"config","user.name","Fixture"],cwd:root});
  writeFileSync(join(root,"README.md"),"fixture\r\n","utf8");
  await runCommand({argv:["git","-C",root,"add","README.md"],cwd:root});
  await runCommand({argv:["git","-C",root,"commit","-m","fixture"],cwd:root});
  return {root,head:(await runCommand({argv:["git","-C",root,"rev-parse","HEAD"],cwd:root})).stdout.trim()};
}
export function taskInput(head,gates=[]) {
  return {title:"Fixture task",goal:"Exercise the control plane",source:{repository_id:"fixture",base_commit:head},scope:{allow:["**/*"],deny:[]},acceptance:[{criterion_id:"ac_1",statement:"Run is evidenced"}],verification:{gates},guardrails:{irreversible_actions:{commit:"human_required",merge:"human_required",push:"human_required",publish:"human_required",discard:"human_required"}},execution:{preferred_runtime:"fake",required_capabilities:["structured_events"],budget:{}},metadata:{task_class:"test",labels:["fixture"]}};
}
