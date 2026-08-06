import { runCommand } from "./process.mjs";
import { resolve, sep } from "node:path";

function gateArgv(gate) {
  if(Array.isArray(gate.argv)&&gate.argv.length) return gate.argv;
  if(typeof gate.command==="string") return process.platform==="win32"?["powershell.exe","-NoProfile","-NonInteractive","-Command",gate.command]:["/bin/sh","-lc",gate.command];
  throw new Error(`Gate ${gate.gate_id} has no command`);
}
export function parseObservedTests(output,parser="generic") {
  if(parser==="none") return null;
  const values=[];
  for(const pattern of [/# tests\s+(\d+)/gi,/\bTests?\s*:?\s*(\d+)\s+passed/gi,/\b(\d+)\s+tests?\s+passed/gi,/\b(\d+)\s+passed\b/gi]) {
    for(const match of output.matchAll(pattern)) values.push(Number(match[1]));
  }
  return values.length?Math.max(...values):0;
}
export async function runVerificationMatrix({store,runId,taskSpec,worktreePath}) {
  const results=[];
  for(const gate of taskSpec.verification.gates) {
    const root=resolve(worktreePath),cwd=gate.cwd?resolve(root,gate.cwd):root;
    if(cwd!==root&&!cwd.startsWith(`${root}${sep}`)) throw new Error(`Gate ${gate.gate_id} cwd escapes worktree`);
    const argv=gateArgv(gate);
    const commandId=`cmd_${runId}_${gate.gate_id}`;
    store.appendEvent(runId,{actor:{role:"Verifier",id:"control-plane-verifier"},source:{kind:"verifier"},type:"command.activity",summary:`Starting ${gate.gate_id}`,data:{command_id:commandId,phase:"started",cwd:gate.cwd??".",argv_redacted:argv}});
    const command=await runCommand({argv,cwd,timeoutMs:(gate.timeout_seconds??300)*1000});
    const output=`STDOUT\n${command.stdout}\nSTDERR\n${command.stderr}`;
    const artifact=store.createArtifact(runId,{kind:"verification_output",media_type:"text/plain",source:"verifier",data:output,extension:"txt"});
    const observedTests=parseObservedTests(output,gate.parser??"generic"),minimum=gate.min_tests??0;
    const status=command.exit_code===0&&!command.timed_out&&(observedTests===null||observedTests>=minimum)?"passed":"failed";
    const result={gate_id:gate.gate_id,kind:gate.kind??"custom",required:gate.required!==false,status,exit_code:command.exit_code,timed_out:command.timed_out,duration_ms:command.duration_ms,observed_tests:observedTests,min_tests:minimum,result_artifact_id:artifact.artifact_id};
    store.recordVerification(runId,result); results.push(result);
    store.appendEvent(runId,{actor:{role:"Verifier",id:"control-plane-verifier"},source:{kind:"verifier"},type:"command.activity",summary:`Finished ${gate.gate_id}`,data:{command_id:commandId,phase:status==="passed"?"completed":"failed",cwd:gate.cwd??".",exit_code:command.exit_code,duration_ms:command.duration_ms}});
  }
  return {results,passed:results.every((result)=>!result.required||result.status==="passed")};
}
