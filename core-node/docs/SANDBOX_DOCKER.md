# Docker Sandbox Backend

## Building the image

```bash
cd core-node
docker build -t polymath/sandbox:0.1 .
```

## How it works

The Docker sandbox runs commands inside an isolated container with:
- `--network=none` — no network access
- `--memory=512m` — memory capped at 512 MB
- `--cpus=0.5` — half a CPU core
- `--rm` — container removed after execution

## Volume mounts

The working directory is mounted read-write at `/workspace`:

```
-v <host-cwd>:/workspace -w /workspace
```

Commands execute inside `/workspace` by default. Pass `cwd` in args to change the host path that gets mounted.

## Environment variables

Pass `env` in the args object to inject environment variables into the container via `-e` flags.

## Timeout

Provide an `AbortSignal` to cancel long-running commands. On abort, the container process is killed.
