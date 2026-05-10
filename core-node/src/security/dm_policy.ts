import type { PairingManager } from "./pairing.js";

export type DmPolicy = { mode: "pairing" | "open" | "closed"; channel: string };

export async function evaluateDmPolicy(
  channel: string,
  senderId: string,
  policies: DmPolicy[],
  pairingManager: PairingManager,
): Promise<"allow" | "pair" | "deny"> {
  const policy = policies.find((p) => p.channel === channel);
  if (!policy || policy.mode === "closed") return "deny";
  if (policy.mode === "open") return "allow";
  // pairing mode
  const status = pairingManager.checkSender(channel, senderId);
  if (status === "approved") return "allow";
  if (status === "pending") return "pair";
  // unknown → create pairing
  pairingManager.createPairing(channel, senderId);
  return "pair";
}
