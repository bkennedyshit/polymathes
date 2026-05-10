import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export function detectWsl(): boolean {
  if (process.platform !== "win32") return false;
  return existsSync("C:\\Windows\\System32\\wsl.exe");
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function wslExecute(
  command: string,
  opts: { cwd?: string; env?: Record<string, string> },
  signal: AbortSignal,
): Promise<ExecResult> {
  if (signal.aborted) throw new Error("aborted");
  if (!detectWsl()) throw new Error("WSL not available");

  const wslArgs = ["-d", "polymath-sbx", "--", "sh", "-c", command];

  return new Promise((resolve, reject) => {
    const proc = execFile("wsl.exe", wslArgs, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      maxBuffer: 10 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? (err as any).code ?? 1 : 0 });
    });

    const onAbort = () => { proc.kill(); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    proc.on("close", () => signal.removeEventListener("abort", onAbort));
  });
}
