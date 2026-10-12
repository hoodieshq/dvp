use dvp_swap_program_client::{
    confidential::{
        mint_auditor, settle_session, BalanceEvent, ConfidentialError, EscrowKeys, SessionConfig,
        SettleRequest, TransactionSession, TransferSource,
    },
    instructions::SettleConfidentialDvp,
    verify::verify_confidential_funding,
};
use solana_account::Account;
use solana_instruction::AccountMeta;

/// Fetch these five accounts together, after Apply confirms. Addresses are the
/// corresponding generated Settle accounts; do not reuse pre-Apply snapshots.
pub struct Snapshot<'a> {
    pub swap: &'a Account,
    pub escrow: &'a Account,
    pub recipient: &'a Account,
    pub surplus_recipient: &'a Account,
    pub mint: &'a Account,
}

/// Build proofs from checked current state, including the mint's optional auditor.
/// Resolve hook extras beforehand; hooked Settle requires V1. Send the resulting
/// preparations in order, then the final transaction with the settlement authority.
#[allow(clippy::too_many_arguments)]
pub fn settle(
    config: &SessionConfig,
    accounts: SettleConfidentialDvp,
    snapshot: Snapshot<'_>,
    keys: &EscrowKeys,
    expected_amount_b: u64,
    history: &[BalanceEvent],
    leg_a_extras: &[AccountMeta],
    leg_b_extras: &[AccountMeta],
) -> Result<TransactionSession, ConfidentialError> {
    let (swap, escrow) = verify_confidential_funding(
        &accounts.swap_dvp,
        snapshot.swap,
        &accounts.dvp_ata_b,
        snapshot.escrow,
        keys,
        expected_amount_b,
    )?;
    let recipient = super::recipient(snapshot.recipient, &swap.base.mint_b)?;
    let surplus_recipient = super::recipient(snapshot.surplus_recipient, &swap.base.mint_b)?;
    let auditor = mint_auditor(&snapshot.mint.owner, &snapshot.mint.data)?;
    settle_session(
        config,
        accounts,
        SettleRequest {
            source: TransferSource {
                state: &escrow,
                keys,
                history,
            },
            swap: &swap,
            expected_amount_b,
            recipient: &recipient,
            surplus_recipient: &surplus_recipient,
            auditor: auditor.as_ref(),
        },
        leg_a_extras,
        leg_b_extras,
    )
}
