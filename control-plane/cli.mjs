#!/usr/bin/env node
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import { ControlPlaneOrchestrator } from "./orchestrator.mjs";
import { createControlPlaneServer } from "./server.mjs";
import { ControlPlaneStore } from "./store.mjs";

function option(name,fallback) { const index=process.argv.indexOf(name);return index>=0?process.argv[index+1]:fallback; }
const command=process.argv[2]??"serve";
const stateRoot=resolve(option("--state",process.env.CROSS_AGENT_STATE_DIR??join(homedir(),".openhands","agent-canvas","control-plane")));
const store=new ControlPlaneStore(stateRoot),orchestrator=new ControlPlaneOrchestrator({store,worktreesRoot:join(stateRoot,"worktrees")});

try {
  if(command==="serve") {
    const port=Number(option("--port",process.env.CROSS_AGENT_CONTROL_PLANE_PORT??18002));
    const server=createControlPlaneServer({store,orchestrator,apiKey:process.env.CONTROL_PLANE_API_KEY});
    await orchestrator.reconcile(); server.listen(port,"127.0.0.1",()=>console.log(`Control Plane listening at http://127.0.0.1:${port}`));
    const stop=()=>server.close(()=>{store.close();process.exit(0);});process.on("SIGINT",stop);process.on("SIGTERM",stop);
  } else if(command==="create-task") {
    console.log(JSON.stringify(store.createTask(JSON.parse(readFileSync(resolve(option("--file")),"utf8"))),null,2));store.close();
  } else if(command==="run") {
    const task=store.getTask(option("--task"),Number(option("--revision",1)));
    const started=await orchestrator.startTask({taskId:task.task_id,taskRevision:task.revision,repositoryRoot:resolve(option("--repo")),runtimeId:option("--runtime",task.execution.preferred_runtime),runtimeOptions:{mode:option("--fake-mode","success")}});
    console.log(JSON.stringify(await started.completion,null,2));store.close();
  } else if(command==="rebuild-index") { console.log(JSON.stringify(store.rebuildIndex(),null,2));store.close(); }
  else throw new Error(`Unknown command: ${command}`);
} catch(error) { store.close();console.error(error.message);process.exit(1); }
