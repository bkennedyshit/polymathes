import { execFile } from "node:child_process";

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  key_path: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function sshExecute(
  command: string,
  opts: { env?: Record<string, string> },
  config: SshConfig,
  signal: AbortSignal,
): Promise<ExecResult> {
  if (signal.aborted) throw new Error("aborted");

  const envPrefix = opts.env
    ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`).join(" ") + " "
    : "";
  const remoteCmd = envPrefix + command;

  const args = [
    "-i", config.key_path,
    "-p", String(config.port),
    "-o", "StrictHostKeyChecking=no",
    "-o", "BatchMode=yes",
    `${config.user}@${config.host}`,
    remoteCmd,
  ];

  return new Promise((resolve, reject) => {
    const proc = execFile("ssh", args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ stdout, stderr, exitCode: err ? (err as any).code ?? 1 : 0 });
    });

    const onAbort = () => { proc.kill(); reject(new Error("aborted")); };
    signal.addEventListener("abort", onAbort, { once: true });
    proc.on("close", () => signal.removeEventListener("abort", onAbort));
  });
}
