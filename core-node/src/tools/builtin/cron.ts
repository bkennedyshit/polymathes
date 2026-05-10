import { z } from "zod";
import type { ToolRegistry } from "../registry.js";
import type { CronScheduler } from "../../cron/scheduler.js";

let scheduler: CronScheduler | undefined;

export function setScheduler(s: CronScheduler): void {
  scheduler = s;
}

export function register(registry: ToolRegistry): void {
  registry.register({
    name: "cron_add",
    description: "Schedule a recurring task",
    parameters: z.object({ expr: z.string(), task: z.string() }),
    async handler(args: any) {
      if (!scheduler) throw new Error("Scheduler not initialized");
      const job = scheduler.addJob({ cron_expr: args.expr, task: args.task });
      return { id: job.id, ok: true };
    },
    toolset: "cron",
  });

  registry.register({
    name: "cron_list",
    description: "List scheduled tasks",
    parameters: z.object({}),
    async handler() {
      if (!scheduler) throw new Error("Scheduler not initialized");
      return { jobs: scheduler.listJobs() };
    },
    toolset: "cron",
  });

  registry.register({
    name: "cron_remove",
    description: "Remove a scheduled task",
    parameters: z.object({ id: z.string() }),
    async handler(args: any) {
      if (!scheduler) throw new Error("Scheduler not initialized");
      scheduler.removeJob(args.id);
      return { ok: true };
    },
    toolset: "cron",
  });

  registry.register({
    name: "cron_trigger_now",
    description: "Immediately fire a cron job by ID",
    parameters: z.object({ id: z.string() }),
    async handler(args: any) {
      if (!scheduler) throw new Error("Scheduler not initialized");
      const jobs = scheduler.listJobs();
      const job = jobs.find((j) => j.id === args.id);
      if (!job) return { error: "job not found" };
      // Access the onFire callback via the scheduler's internal mechanism
      // We re-use the scheduler's DB to mark last_run and trigger
      (scheduler as any).db.prepare("UPDATE cron_jobs SET last_run = datetime('now') WHERE id = ?").run(job.id);
      await (scheduler as any).onFire(job);
      return { ok: true };
    },
    toolset: "cron",
  });

  registry.register({
    name: "cron_enable",
    description: "Enable a cron job by ID",
    parameters: z.object({ id: z.string() }),
    async handler(args: any) {
      if (!scheduler) throw new Error("Scheduler not initialized");
      (scheduler as any).db.prepare("UPDATE cron_jobs SET enabled = 1 WHERE id = ?").run(args.id);
      return { ok: true };
    },
    toolset: "cron",
  });

  registry.register({
    name: "cron_disable",
    description: "Disable a cron job by ID",
    parameters: z.object({ id: z.string() }),
    async handler(args: any) {
      if (!scheduler) throw new Error("Scheduler not initialized");
      (scheduler as any).db.prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?").run(args.id);
      return { ok: true };
    },
    toolset: "cron",
  });
}
