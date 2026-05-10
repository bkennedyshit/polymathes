import { execFile } from "node:child_process";
import type { SandboxPolicy } from "./policy.js";

let dockerAvailable: boolean | null = null;

export async function detectDocker(): Promise<boolean> {
  if (dockerAvailable !== null) return dockerAvailable;
  return new Promise((resolve) => {
    execFile("docker", ["info"], (err) => {
      dockerAvailable = !err;
      resolve(dockerAvailable);
    });
  });
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function dockerExecute(
  _handler: never,
  command: string,
  args: { cwd?: string; env?: Record<string, string> },
  _policy: SandboxPolicy,
  signal: AbortSignal,
): Promise<ExecResult> {
  if (signal.aborted) throw new Error("aborted");
  const cwd = args.cwd || process.cwd();
  const dockerArgs = [
    "run", "--rm",
    "--network=none",
    "--memory=512m",
    "--cpus=0.5",
    "-v", `${cwd}:/workspace`,
    "-w", "/workspace",
    ...(args.env ? Object.entries(args.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]) : []),
    "polymath/sandbox:0.1",
    "sh", "-c", command,
  ];

  return new Promise((resolve, reject) => {
    const proc = execFile("docker", dockerArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? (err as any).code ?? 1 : 0 });
    });

    const onAbort = () => {
      proc.kill();
      execFile("docker", ["stop", proc.pid?.toString() ?? ""], () => {});
      reject(new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    proc.on("close", () => signal.removeEventListener("abort", onAbort));
  });
}
