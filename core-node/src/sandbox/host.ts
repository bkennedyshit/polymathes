export async function hostExecute(
  handler: (args: unknown, ctx: unknown) => Promise<unknown>,
  args: unknown,
  ctx: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new Error("aborted");
  return handler(args, ctx);
}
