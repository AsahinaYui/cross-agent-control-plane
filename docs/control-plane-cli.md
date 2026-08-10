# `cap` terminal MVP contract

`cap` is a thin client for the local Cross Agent Control Plane. The daemon is
the authority for tasks, sessions, assignments, leases, handoffs, runs, and
terminal decisions; the terminal, overlay, and editor integrations are optional
surfaces over the same API. The default state directory is `~/.cap`.
`attach` defaults to `terminal` surface unless `--surface` is given.

## Commands

```text
cap up [--overlay]
cap attach <repository> [--surface <name>]
cap run --workflow <workflow.json> <goal>
cap status [task-id]
cap logs [task-or-run] [--follow]
cap stop [task-or-run]
cap decide <task-id> --decision accepted|changes_requested|rejected
```

`up` starts the loopback daemon and returns after its health endpoint responds.
`attach` records the current repository and surface-owned Coordinator identity;
it does not change the surface's provider or model. `run` submits a versioned
workflow and prints durable Task identifiers. `status`, `logs`, and `stop`
default to the most recently submitted Task for the attached repository.
`decide` is the explicit current-session Coordinator action that persists the
aggregate terminal decision. No command commits, pushes, publishes, or changes
global ccSwitch configuration.

## Workflow manifest v1

The dependency-free P0 accepts JSON. YAML is intentionally deferred until a
real parser can be justified; a YAML-looking file fails with a clear message.

```json
{
  "version": 1,
  "workspace": { "policy": "mission" },
  "coordinator": { "mode": "current-session" },
  "limits": {
    "concurrency": 1,
    "max_duration_seconds": 1800,
    "inactivity_timeout_seconds": 300,
    "repeated_failure_limit": 2,
    "max_tokens": null,
    "max_cost_usd": null
  },
  "steps": [
    {
      "id": "implementation",
      "runtime": "codex-cli",
      "provider": { "source": "runtime-native", "id": "surface-route" },
      "model": "configured-model",
      "responsibility": "Implement the requested change",
      "writes": true,
      "depends_on": [],
      "timeout_seconds": 900
    }
  ]
}
```

Step IDs and responsibilities are arbitrary. Managed steps pin their runtime,
provider route, model, write intent, dependencies, timeout, and optional
workspace policy. `executor: "coordinator"` represents work performed by the
attached current session and therefore does not require a managed runtime
profile. Dependencies form an acyclic DAG and run with the manifest's bounded
concurrency. Concurrent writers never share one workspace.

Workspace policies are:

- `shared`: use the attached repository directly; rejected when it would allow
  concurrent writers.
- `mission`: reuse one Mission worktree (the sequential default).
- `isolated`: create a dedicated worktree for the Assignment.
- `auto`: use `mission` unless isolation is required to avoid writer collision.

## Runtime adapter contract

An adapter exposes `describe`, `start`, `wait`, `cancel`, `recover`, and
`normalize`. `describe` declares capabilities; `start` receives a structured
prompt, pinned model, optional command prefix, workspace path, environment,
write intent, and an explicit safe resume ID. A process is not persisted as
running until its spawn succeeds. Normalized events may report activity,
external session identity, observed model, token usage, and cost.

Failed, blocked, timed-out, inactive, budget-exhausted, or repeated-identical
failure sessions are never resumed automatically. Retry requires a new explicit
Assignment/CorrectionDelta.

## Deliberate P0 limits

- JSON manifests only.
- Built-in runtime adapters only; a stable plugin loader is P1.
- Bounded dependency DAG, not recursive delegation or workflow invention.
- Token/cost limits are enforced only when the adapter reports usage; otherwise
  they remain visible as `unavailable`, never estimated silently.
