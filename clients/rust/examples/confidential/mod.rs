//! Copyable integration recipes. Build with `cargo build -p dvp-swap-program-client
//! --example confidential --features confidential,fetch`.
//!
//! Call create, verify/fund using your Token-2022 wallet, apply, then settle.
//! Fetch fresh snapshots after each confirmed operation. Refunds are an alternative
//! to settlement; cleanup is only for abandoned preparations. See rust-client.md.
pub mod create_apply;
pub mod refunds;
pub mod send;
pub mod settle;

use dvp_swap_program_client::confidential::ConfidentialError;
use solana_account::Account;
use solana_pubkey::Pubkey;
use spl_token_2022_interface::extension::{
    confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensions,
    StateWithExtensions,
};

fn recipient(
    account: &Account,
    mint: &Pubkey,
) -> Result<ConfidentialTransferAccount, ConfidentialError> {
    if account.owner != spl_token_2022_interface::ID {
        return Err(ConfidentialError::Account("recipient token program"));
    }
    let state =
        StateWithExtensions::<spl_token_2022_interface::state::Account>::unpack(&account.data)
            .map_err(|_| ConfidentialError::Account("recipient layout"))?;
    if state.base.mint != *mint {
        return Err(ConfidentialError::Account("recipient mint"));
    }
    state
        .get_extension::<ConfidentialTransferAccount>()
        .copied()
        .map_err(|_| ConfidentialError::Account("recipient CT extension"))
}
