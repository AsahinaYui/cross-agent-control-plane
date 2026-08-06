import axios from "axios";
import { getEffectiveLocalBackend } from "#/api/backend-registry/active-store";

export interface ControlPlaneTask {
  task_id: string;
  revision: number;
  title: string;
  goal: string;
  state: string;
  spec_hash: string;
  metadata: { task_class: string; labels: string[] };
}
export interface ControlPlaneRun {
  run_id: string;
  task_id: string;
  task_revision: number;
  role: string;
  runtime_id: string;
  adapter_version: string;
  state: string;
  created_at: string;
  updated_at: string;
}
export interface ControlPlaneRunDetail extends ControlPlaneRun {
  context: {
    parent_run_id: string | null;
    correction_delta_id: string | null;
    model_identity: {
      requested_model: string | null;
      expected_model: string | null;
    } | null;
  };
  events: Array<{
    event_id: string;
    sequence: number;
    type: string;
    summary: string;
    recorded_at: string;
    actor: { role: string; id: string };
  }>;
  artifacts: Array<{
    artifact_id: string;
    kind: string;
    sha256: string;
    bytes: number;
    created_at: string;
  }>;
  verification: Array<{
    gate_id: string;
    status: string;
    required: boolean;
    observed_tests?: number;
  }>;
  bundle: {
    bundle_id: string;
    manifest_sha256: string;
    runtime: {
      runtime_id: string;
      adapter_version: string;
      observed_model: string | null;
    };
  } | null;
  bundle_integrity: boolean | null;
  decisions: Array<{
    decision_id: string;
    decision: string;
    created_at: string;
  }>;
}

function client() {
  const backend = getEffectiveLocalBackend();
  return axios.create({
    baseURL: backend?.host,
    headers: backend?.apiKey
      ? { "X-Session-API-Key": backend.apiKey }
      : undefined,
  });
}
export class ControlPlaneService {
  static async listTasks(): Promise<ControlPlaneTask[]> {
    return (
      await client().get<{ items: ControlPlaneTask[] }>(
        "/api/control-plane/v1/tasks",
      )
    ).data.items;
  }
  static async listRuns(): Promise<ControlPlaneRun[]> {
    return (
      await client().get<{ items: ControlPlaneRun[] }>(
        "/api/control-plane/v1/runs",
      )
    ).data.items;
  }
  static async getRun(runId: string): Promise<ControlPlaneRunDetail> {
    return (
      await client().get<ControlPlaneRunDetail>(
        `/api/control-plane/v1/runs/${encodeURIComponent(runId)}`,
      )
    ).data;
  }
}
