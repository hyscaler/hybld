import { mkdirSync, renameSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const STALE_MS = 60_000;

/**
 * Project-level build lock: atomic mkdir with PID + heartbeat, stale
 * detection for crashed processes (FR-15).
 */
export class BuildLock {
  private heartbeat: NodeJS.Timeout | null = null;
  private held = false;
  private readonly token = randomUUID();

  constructor(private dir: string) {}

  private infoPath() {
    return join(this.dir, "lock.json");
  }

  private readInfo(): { pid: number; time: number; token?: string } | null {
    try {
      return JSON.parse(readFileSync(this.infoPath(), "utf8"));
    } catch {
      return null;
    }
  }

  private isStale(info: { pid: number; time: number } | null): boolean {
    if (!info) return true; // unreadable lock info
    if (Date.now() - info.time > STALE_MS) return true;
    try {
      process.kill(info.pid, 0);
      return false; // process alive and heartbeat fresh
    } catch {
      return true; // process gone
    }
  }

  /**
   * Remove a stale lock without racing a concurrent recovery: rename the dir
   * aside (atomic claim), verify it is the exact lock we judged stale, and
   * only then delete it. If we grabbed a fresh lock someone else just
   * created, put it back.
   */
  private takeOverStale(staleToken: string | undefined): void {
    const tomb = `${this.dir}.stale-${process.pid}-${this.token.slice(0, 8)}`;
    try {
      renameSync(this.dir, tomb);
    } catch {
      return; // someone else already claimed or removed it
    }
    let claimed: { token?: string } | null = null;
    try {
      claimed = JSON.parse(readFileSync(join(tomb, "lock.json"), "utf8"));
    } catch {
      claimed = null;
    }
    if (claimed && staleToken && claimed.token !== staleToken) {
      // Not the lock we inspected: a fresh holder acquired in between. Restore it.
      try {
        renameSync(tomb, this.dir);
      } catch {
        rmSync(tomb, { recursive: true, force: true });
      }
      return;
    }
    rmSync(tomb, { recursive: true, force: true });
  }

  async acquire(wait = false): Promise<void> {
    for (;;) {
      try {
        mkdirSync(this.dir, { recursive: false });
        this.held = true;
        this.writeInfo();
        this.heartbeat = setInterval(() => this.writeInfo(), STALE_MS / 3);
        this.heartbeat.unref();
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        const info = this.readInfo();
        if (this.isStale(info)) {
          this.takeOverStale(info?.token);
          continue;
        }
        if (!wait) {
          throw new Error(
            `Another hybld build is running (lock: ${this.dir}). Use --wait to queue behind it.`
          );
        }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  private writeInfo() {
    try {
      writeFileSync(this.infoPath(), JSON.stringify({ pid: process.pid, time: Date.now(), token: this.token }));
    } catch {
      /* lock dir may be gone during release */
    }
  }

  release(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.held) {
      rmSync(this.dir, { recursive: true, force: true });
      this.held = false;
    }
  }
}
