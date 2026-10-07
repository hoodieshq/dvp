import { fetchEncodedAccount, type AccountMeta } from "@solana/kit";
import {
  findExtraAccountMetaListPda,
  resolveExtraAccountMetasForExecute,
  type ResolveExtraAccountMetasForExecuteInput,
} from "@solana-program/token-2022";
import { hookExtras } from "./lifecycle";
import { U64_MAX } from "./constants";

/** Confidential transfers invoke Execute with the hidden amount sentinel. */
export async function resolveConfidentialHookAccounts(
  input: Omit<ResolveExtraAccountMetasForExecuteInput, "amount">,
): Promise<AccountMeta[]> {
  const [validation] = input.validateStatePubkey
    ? [input.validateStatePubkey]
    : await findExtraAccountMetaListPda(
        { mint: input.mint },
        { programAddress: input.transferHookProgramAddress },
      );
  const account = await fetchEncodedAccount(input.rpc, validation);
  if (!account.exists) throw new Error("Missing hook validation account");
  return hookExtras({
    legB: await resolveExtraAccountMetasForExecute({
      ...input,
      validateStatePubkey: validation,
      amount: U64_MAX,
    }),
  });
}
