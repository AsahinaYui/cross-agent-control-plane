import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export function writeLease(path, value) {
  const temp=`${path}.${process.pid}.tmp`; writeFileSync(temp,`${JSON.stringify(value,null,2)}\n`,"utf8"); renameSync(temp,path);
}
export function readLease(path) { return existsSync(path)?JSON.parse(readFileSync(path,"utf8")):null; }
export function isProcessAlive(pid) { try { process.kill(pid,0); return true; } catch { return false; } }

export async function terminateProcessTree(child, graceMs=1500) {
  if(!child?.pid || child.exitCode!==null) return;
  child.kill("SIGTERM");
  await new Promise((resolve)=>setTimeout(resolve,graceMs));
  if(child.exitCode!==null) return;
  if(process.platform==="win32") await new Promise((resolve)=>spawn("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore"}).once("exit",resolve));
  else { try { process.kill(-child.pid,"SIGKILL"); } catch { child.kill("SIGKILL"); } }
}

export function spawnOwnedProcess({argv,cwd,env,onStdout,onStderr}) {
  if(!Array.isArray(argv)||!argv.length) throw new Error("argv must not be empty");
  const child=spawn(argv[0],argv.slice(1),{cwd,env:{...process.env,...env},stdio:["pipe","pipe","pipe"],windowsHide:true,detached:process.platform!=="win32"});
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data",(chunk)=>onStdout?.(chunk)); child.stderr.on("data",(chunk)=>onStderr?.(chunk));
  const completion=new Promise((resolve,reject)=>{child.once("error",reject);child.once("exit",(code,signal)=>resolve({exit_code:code,signal}));});
  return {child,completion,send:(message)=>child.stdin.write(`${message}\n`),cancel:()=>terminateProcessTree(child)};
}

export async function runCommand({argv,cwd,env,timeoutMs=300000}) {
  let stdout="",stderr="",timedOut=false; const started=Date.now();
  const handle=spawnOwnedProcess({argv,cwd,env,onStdout:(x)=>stdout+=x,onStderr:(x)=>stderr+=x});
  const timer=setTimeout(()=>{timedOut=true;void handle.cancel();},timeoutMs);
  const result=await handle.completion; clearTimeout(timer);
  return {...result,stdout,stderr,timed_out:timedOut,duration_ms:Date.now()-started,pid:handle.child.pid};
}
