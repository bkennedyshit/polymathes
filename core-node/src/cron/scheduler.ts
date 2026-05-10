import { Cron } from "croner";
import type Database from "better-sqlite3";
import { nanoid } from "nanoid";

export interface CronJob {
  id: string;
  cron_expr: string;
  agent_id: string | null;
  task: string | null;
  channel: string | null;
  enabled: number;
  last_run: string | null;
  next_run: string | null;
}

export interface CronSchedulerOpts {
  db: Database.Database;
  onFire: (job: CronJob) => Promise<void>;
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

export class CronScheduler {
  private db: Database.Database;
  private onFire: (job: CronJob) => Promise<void>;
  private logger: { warn: (msg: string) => void; info: (msg: string) => void };
  private handles = new Map<string, Cron>();

  constructor({ db, onFire, logger }: CronSchedulerOpts) {
    this.db = db;
    this.onFire = onFire;
    this.logger = logger ?? { warn: console.warn, info: console.log };
  }

  start(): void {
    const jobs = this.db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all() as CronJob[];
    for (const job of jobs) this.schedule(job);
  }

  stop(): void {
    for (const h of this.handles.values()) h.stop();
    this.handles.clear();
  }

  addJob(partial: { cron_expr: string; agent_id?: string; task?: string; channel?: string }): CronJob {
    const id = nanoid();
    const job: CronJob = {
      id,
      cron_expr: partial.cron_expr,
      agent_id: partial.agent_id ?? null,
      task: partial.task ?? null,
      channel: partial.channel ?? null,
      enabled: 1,
      last_run: null,
      next_run: null,
    };
    this.db.prepare(
      "INSERT INTO cron_jobs (id, cron_expr, agent_id, task, channel, enabled) VALUES (?, ?, ?, ?, ?, 1)"
    ).run(job.id, job.cron_expr, job.agent_id, job.task, job.channel);
    this.schedule(job);
    return job;
  }

  removeJob(id: string): void {
    this.db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(id);
    const h = this.handles.get(id);
    if (h) { h.stop(); this.handles.delete(id); }
  }

  listJobs(): CronJob[] {
    return this.db.prepare("SELECT * FROM cron_jobs").all() as CronJob[];
  }

  private schedule(job: CronJob): void {
    try {
      const handle = new Cron(job.cron_expr, () => {
        this.db.prepare("UPDATE cron_jobs SET last_run = datetime('now') WHERE id = ?").run(job.id);
        this.onFire(job);
      });
      this.handles.set(job.id, handle);
    } catch (e: any) {
      this.logger.warn(`Invalid cron expression for job ${job.id}: ${e.message}`);
    }
  }
}
