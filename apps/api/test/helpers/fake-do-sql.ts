export type FakeDroppedRow = { sha256: string; last_seq: number };
export type FakeSeqRootRow = { seq: number; manifest_sha: string; carrier_sha: string | null };

/** Minimal, strict SqlStorage model for WorkspaceSync's design-96 statements. */
export function fakeDoSql(initial?: { dropped?: FakeDroppedRow[]; seqRoots?: FakeSeqRootRow[] }) {
  const dropped = new Map((initial?.dropped ?? []).map((row) => [row.sha256, { ...row }]));
  const seqRoots = new Map((initial?.seqRoots ?? []).map((row) => [row.seq, { ...row }]));

  return {
    __dropped: dropped,
    __seqRoots: seqRoots,
    exec(query: string, ...bindings: unknown[]) {
      const sql = query.replace(/\s+/g, " ").trim().toLowerCase();
      let rows: Array<FakeDroppedRow | FakeSeqRootRow> = [];
      if (sql.startsWith("create table") || sql.startsWith("create index")) {
        // Schema creation is intentionally idempotent.
      } else if (sql.startsWith("insert into dropped_index")) {
        const sha256 = String(bindings[0]);
        dropped.set(sha256, { sha256, last_seq: Number(bindings[1]) });
      } else if (sql === "delete from dropped_index where sha256 = ?") {
        dropped.delete(String(bindings[0]));
      } else if (sql === "delete from dropped_index") {
        dropped.clear();
      } else if (sql.startsWith("delete from dropped_index where sha256 in")) {
        const floor = Number(bindings[0]);
        const limit = Number(bindings[1]);
        for (const row of [...dropped.values()].filter((row) => row.last_seq <= floor).slice(0, limit)) dropped.delete(row.sha256);
      } else if (sql.startsWith("insert or replace into seq_roots")) {
        const seq = Number(bindings[0]);
        seqRoots.set(seq, { seq, manifest_sha: String(bindings[1]), carrier_sha: bindings[2] == null ? null : String(bindings[2]) });
      } else if (sql === "delete from seq_roots") {
        seqRoots.clear();
      } else if (sql.startsWith("delete from seq_roots where seq in")) {
        const floor = Number(bindings[0]);
        const limit = Number(bindings[1]);
        for (const row of [...seqRoots.values()].filter((row) => row.seq <= floor).slice(0, limit)) seqRoots.delete(row.seq);
      } else if (sql.startsWith("select sha256 from dropped_index") || sql.startsWith("select sha256,last_seq from dropped_index")) {
        const floor = Number(bindings[0]);
        const cursor = String(bindings[1]);
        const limit = Number(bindings[2]);
        rows = [...dropped.values()]
          .filter((row) => row.last_seq > floor && row.sha256 > cursor)
          .sort((a, b) => a.sha256.localeCompare(b.sha256))
          .slice(0, limit);
      } else if (sql.startsWith("select seq,manifest_sha,carrier_sha from seq_roots")) {
        const floor = Number(bindings[0]);
        const head = Number(bindings[1]);
        const cursor = Number(bindings[2]);
        const limit = Number(bindings[3]);
        rows = [...seqRoots.values()]
          .filter((row) => row.seq > floor && row.seq <= head && row.seq > cursor)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit);
      } else {
        throw new Error(`fakeDoSql: unsupported statement: ${query}`);
      }
      return { toArray: () => rows.map((row) => ({ ...row })) };
    },
  };
}
