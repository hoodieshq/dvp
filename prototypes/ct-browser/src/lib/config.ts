import { address } from '@solana/kit';

/** DvP program deployed on devnet from `devnet/ct-golden-path`. */
export const PROGRAM_ID = address('bVntZ9Us9Wv8v2hMytmzLs4omXcZf3UwJ5xXbB3TnA6');
export const DECIMALS = 6;
/** Public balances minted by /api/setup: mint A to party A, mint B to party B. */
export const START_A = 100_000_000n;
export const START_B = 100_000_000n;
/** Trade terms: party A delivers AMOUNT_A of mint A for AMOUNT_B (confidential) of mint B. */
export const AMOUNT_A = 25_000_000n;
export const AMOUNT_B = 40_000_000n;
