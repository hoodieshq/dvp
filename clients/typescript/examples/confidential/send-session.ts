import type { GetLatestBlockhashApi, Rpc } from "@solana/kit";
import type {
  PlannedTransaction,
  SessionConfig,
  TransactionSession,
} from "../../src/confidential";

/** sendAndConfirm must submit as base64, check execution errors and await confirmed commitment. */
export async function sendSession(
  rpc: Rpc<GetLatestBlockhashApi>,
  config: SessionConfig,
  session: TransactionSession,
  sendAndConfirm: (
    transaction: Awaited<ReturnType<PlannedTransaction["sign"]>>,
  ) => Promise<void>,
) {
  // Each preparation must land before its proof context can be used by Settle.
  for (const plan of [...session.preparation, session.finalTransaction]) {
    const { value: lifetime } = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    await sendAndConfirm(await plan.sign(config, lifetime));
  }
}
