import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { daemonCrashLogPath, daemonDatedLogBasename, daemonRuntimeDir } from "../rbox-paths.js";

export type DaemonLogSink = (message: string) => void;

type SyncFs = Pick<typeof fs,
  "mkdirSync" | "openSync" | "writeSync" | "closeSync" | "fstatSync" |
  "readdirSync" | "lstatSync" | "unlinkSync"
>;

const DATED_NAME = /^daemon-(\d{4})-(\d{2})-(\d{2})\.log$/;
const DEFAULT_RETENTION_DAYS = 14;
const MAX_RETENTION_DAYS = 3650;
const LINK_CHECK_MS = 60_000;
const LINK_CHECK_RECORDS = 512;

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function writeAll(io: SyncFs, fd: number, record: Buffer): void {
  let offset = 0;
  while (offset < record.length) {
    const written = io.writeSync(fd, record, offset, record.length - offset);
    if (written <= 0) throw new Error("daemon log write made no progress");
    offset += written;
  }
}

function utcDayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 86_400_000);
}

export function parseDaemonLogRetentionDays(value: string | undefined): { days: number; warning?: string } {
  if (value === undefined) return { days: DEFAULT_RETENTION_DAYS };
  if (!/^[0-9]+$/.test(value)) return { days: DEFAULT_RETENTION_DAYS, warning: `invalid RBOX_LOG_RETENTION_DAYS=${JSON.stringify(value)}; using ${DEFAULT_RETENTION_DAYS}` };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return { days: DEFAULT_RETENTION_DAYS, warning: `invalid RBOX_LOG_RETENTION_DAYS=${JSON.stringify(value)}; using ${DEFAULT_RETENTION_DAYS}` };
  }
  return { days: Math.min(parsed, MAX_RETENTION_DAYS) };
}

export function parseDaemonDatedLogBasename(name: string): { basename: string; day: number } | undefined {
  const match = DATED_NAME.exec(name);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const millis = Date.UTC(year, month - 1, date);
  const roundTrip = new Date(millis);
  if (roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== date) return undefined;
  return { basename: name, day: Math.floor(millis / 86_400_000) };
}

/** Per-daemon synchronous logger. Primary failures fall back to the independently
 * opened crash channel and never escape into daemon work. */
export class RotatingDaemonLogger {
  readonly log: DaemonLogSink;
  private readonly runtimeDir: string;
  private readonly crashPath: string;
  readonly bootId: string;
  private readonly pid: number;
  private readonly retentionDays: number;
  private crashFd?: number;
  private datedFd?: number;
  private currentBasename?: string;
  private recordsSinceLinkCheck = 0;
  private lastLinkCheckMs = Number.NEGATIVE_INFINITY;
  private pruneAfterRecord = false;
  private closed = false;
  private selfReported = false;

  constructor(
    root: string,
    private readonly clock: () => Date = () => new Date(),
    private readonly io: SyncFs = fs,
    opts: { bootId?: string; pid?: number; retention?: string } = {},
  ) {
    this.runtimeDir = daemonRuntimeDir(root);
    this.crashPath = daemonCrashLogPath(root);
    this.bootId = opts.bootId ?? process.env.RBOX_DAEMON_BOOT_ID ?? crypto.randomBytes(16).toString("hex");
    this.pid = opts.pid ?? process.pid;
    const retention = parseDaemonLogRetentionDays(opts.retention ?? process.env.RBOX_LOG_RETENTION_DAYS);
    this.retentionDays = retention.days;
    this.log = this.write.bind(this);
    try { this.io.mkdirSync(this.runtimeDir, { recursive: true }); } catch { /* fallback opens may still succeed */ }
    try { this.crashFd = this.io.openSync(this.crashPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600); } catch { /* inherited stdio remains the final crash channel */ }
    if (retention.warning) {
      const date = this.clock();
      this.directCrashOrReport(`${date.toISOString()} log warning: ${retention.warning}\n`, date);
    }
  }

  /** The explicit child boot record is kept separate from construction so tests and
   * embedders can construct a sink without claiming a daemon boot. */
  boot(): void {
    this.write(`daemon boot bootId=${this.bootId} pid=${this.pid}`);
  }

  private directCrash(record: string | Buffer): boolean {
    if (this.crashFd === undefined) return false;
    try {
      writeAll(this.io, this.crashFd, Buffer.isBuffer(record) ? record : Buffer.from(record));
      return true;
    } catch {
      return false;
    }
  }

  private directCrashOrReport(record: string | Buffer, date: Date): void {
    if (!this.directCrash(record)) this.reportSinkFailure(date);
  }

  private reportSinkFailure(date: Date): void {
    if (this.selfReported) return;
    this.selfReported = true;
    const line = `${date.toISOString()} log failure: dated and crash sinks unavailable\n`;
    if (this.directCrash(line)) return;
    try { writeAll(this.io, 2, Buffer.from(line)); } catch { /* best effort, never recursive */ }
  }

  private openDated(date: Date, basename: string): boolean {
    try {
      this.datedFd = this.io.openSync(path.join(this.runtimeDir, basename), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
      this.currentBasename = basename;
      this.recordsSinceLinkCheck = 0;
      this.lastLinkCheckMs = date.getTime();
      this.directCrashOrReport(`${date.toISOString()} logs: basename=${basename} bootId=${this.bootId} pid=${this.pid}\n`, date);
      this.pruneAfterRecord = true;
      return true;
    } catch (error) {
      this.datedFd = undefined;
      this.currentBasename = undefined;
      const diagnostic = `${date.toISOString()} log open failed: basename=${basename} code=${errno(error) ?? "UNKNOWN"}\n`;
      if (!this.directCrash(diagnostic)) this.reportSinkFailure(date);
      return false;
    }
  }

  private closeDated(): void {
    const fd = this.datedFd;
    this.datedFd = undefined;
    this.currentBasename = undefined;
    if (fd === undefined) return;
    try { this.io.closeSync(fd); } catch { /* best effort */ }
  }

  private needsReopen(date: Date): boolean {
    if (this.datedFd === undefined) return true;
    this.recordsSinceLinkCheck++;
    if (this.recordsSinceLinkCheck < LINK_CHECK_RECORDS && date.getTime() - this.lastLinkCheckMs < LINK_CHECK_MS) return false;
    this.recordsSinceLinkCheck = 0;
    this.lastLinkCheckMs = date.getTime();
    try { return this.io.fstatSync(this.datedFd).nlink === 0; } catch { return true; }
  }

  private write(message: string): void {
    try { this.writeRecord(message); }
    catch {
      try { this.reportSinkFailure(new Date()); } catch { /* sink contract is never-throw */ }
    }
  }

  private writeRecord(message: string): void {
    if (this.closed) return;
    const date = this.clock();
    const basename = daemonDatedLogBasename(date);
    const changedDate = this.currentBasename !== undefined && this.currentBasename !== basename;
    if (changedDate) this.closeDated();
    if (this.needsReopen(date)) {
      if (this.datedFd !== undefined) this.closeDated();
      this.openDated(date, basename);
    }
    const record = Buffer.from(`${date.toISOString()} ${message}\n`);
    if (this.datedFd !== undefined) {
      try {
        writeAll(this.io, this.datedFd, record);
        if (this.pruneAfterRecord) {
          this.pruneAfterRecord = false;
          this.prune(date);
        }
        return;
      } catch { this.closeDated(); }
    }
    if (!this.directCrash(record)) this.reportSinkFailure(date);
  }

  private warning(date: Date, message: string): void {
    const record = Buffer.from(`${date.toISOString()} log warning: ${message}\n`);
    if (this.datedFd !== undefined) {
      try { writeAll(this.io, this.datedFd, record); return; } catch { this.closeDated(); }
    }
    this.directCrashOrReport(record, date);
  }

  private prune(date: Date): void {
    const today = utcDayNumber(date);
    let names: string[];
    try { names = this.io.readdirSync(this.runtimeDir); }
    catch (error) { this.warning(date, `retention scan failed code=${errno(error) ?? "UNKNOWN"}`); return; }
    for (const name of names) {
      const parsed = parseDaemonDatedLogBasename(name);
      if (!parsed || parsed.day > today || today - parsed.day < this.retentionDays || name === this.currentBasename) continue;
      const candidate = path.join(this.runtimeDir, name);
      try {
        const before = this.io.lstatSync(candidate);
        if (!before.isFile() || before.isSymbolicLink()) continue;
        const after = this.io.lstatSync(candidate);
        if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino) continue;
        this.io.unlinkSync(candidate);
      } catch (error) {
        if (errno(error) !== "ENOENT") this.warning(date, `retention failed basename=${name} code=${errno(error) ?? "UNKNOWN"}`);
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeDated();
    const fd = this.crashFd;
    this.crashFd = undefined;
    if (fd !== undefined) try { this.io.closeSync(fd); } catch { /* best effort */ }
  }
}
