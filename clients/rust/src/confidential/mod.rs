//! Confidential DvP keys, verified balances and unsigned transaction sessions.
//! Sending, retries and shared-seed delivery belong to the caller.

#![deny(warnings)]

mod balance;
mod history;
mod keys;
mod lifecycle;
mod transaction;
pub use balance::*;
pub use history::*;
pub use keys::*;
pub use lifecycle::*;
pub use transaction::*;

#[cfg(test)]
mod tests;

#[derive(Debug, thiserror::Error)]
pub enum ConfidentialError {
    #[error("amount B must be between 1 and 2^48 - 1")]
    InvalidAmount,
    #[error("transfer amount {0} exceeds the 2^48 - 1 limit")]
    TransferAmountTooLarge(u64),
    #[error("partial refund amount must be positive")]
    ZeroPartialRefund,
    #[error("available balance {available} is less than the required {required}")]
    InsufficientAvailable { available: u64, required: u64 },
    #[error("surplus {0} exceeds the 2^48 - 1 transfer limit; reclaim part first")]
    SurplusTooLarge(u64),
    #[error("recipient has not been approved")]
    RecipientNotApproved,
    #[error("recipient confidential credits are disabled")]
    RecipientCreditsDisabled,
    #[error("recipient pending counter cannot accept {required} more credits")]
    RecipientPendingCounterFull { required: u64 },
    #[error("invalid confidential account: {0}")]
    Account(&'static str),
    #[error("shared seed or expected amount does not match the swap")]
    AmountMismatch,
    #[error("the decryptable balance is invalid or does not match the ElGamal balance")]
    BalanceMismatch,
    #[error("transaction history is incomplete or does not match the escrow snapshot")]
    IncompleteHistory,
    #[error("balance arithmetic overflow or underflow")]
    Arithmetic,
    #[error("proof generation failed: {0}")]
    Proof(String),
    #[error("transaction preparation failed: {0}")]
    Transaction(String),
    #[error("transaction size {actual} exceeds the {limit}-byte limit")]
    TransactionTooLarge { actual: usize, limit: usize },
    #[error("hooked Settle requires v1")]
    HookedSettleRequiresV1,
    #[error("swap verification failed: {0}")]
    Swap(#[from] crate::verify::SwapDvpVerifyError),
}

pub const AMOUNT_LO_BITS: usize = 16;
pub const MAX_TRANSFER_AMOUNT: u64 = (1 << 48) - 1;
pub const ELGAMAL_CIPHERTEXT_LEN: usize =
    core::mem::size_of::<solana_zk_sdk_pod::encryption::elgamal::PodElGamalCiphertext>();
