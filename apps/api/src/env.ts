export interface Env {
  rbox_dev_db: D1Database;
  rbox_dev_blobs: R2Bucket;
  RBOX_DEV_TOKEN: string;
  /** WorkspaceSync DO namespace — the per-(workspace,project) commit sequencer + WS fanout. */
  WORKSPACE_SYNC: DurableObjectNamespace;
}
