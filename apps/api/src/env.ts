export interface Env {
  rbox_dev_db: D1Database;
  rbox_dev_blobs: R2Bucket;
  /** Bootstrap trust anchor for the first device (Wrangler secret, never in git). */
  RBOX_BOOTSTRAP_SECRET: string;
  /** WorkspaceSync DO namespace — the per-(workspace,project) commit sequencer + WS fanout. */
  WORKSPACE_SYNC: DurableObjectNamespace;
}
