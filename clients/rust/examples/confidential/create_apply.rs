use dvp_swap_program_client::{
    confidential::{
        apply_session, create_session, derive_shared_seed, read_escrow_account, BalanceEvent,
        ConfidentialError, EscrowKeys, SessionConfig, TransactionSession, TransferSource,
    },
    instructions::{
        ApplyConfidentialDvp, ApplyConfidentialDvpInstructionArgs, CreateConfidentialDvp,
        CreateConfidentialDvpInstructionArgs,
    },
    verify::{find_swap_dvp_address, verify_confidential_funding},
};
use solana_account::Account;
use spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferAccount;

/// The callback calls your KMS/HSM with a dedicated HMAC-SHA256 master key.
/// Deliver the resulting shared seed to both parties over an authenticated channel.
/// Account addresses and public terms are supplied through generated client types.
pub fn create<E>(
    config: &SessionConfig,
    accounts: &CreateConfidentialDvp,
    args: CreateConfidentialDvpInstructionArgs,
    amount_b: u64,
    mac: impl FnOnce(&[u8]) -> Result<[u8; 32], E>,
) -> Result<(TransactionSession, [u8; 32]), Box<dyn std::error::Error>>
where
    E: std::error::Error + 'static,
{
    let expected = find_swap_dvp_address(
        &accounts.settlement_authority,
        &accounts.user_a,
        &accounts.user_b,
        &accounts.mint_a,
        &accounts.mint_b,
        args.nonce,
    )
    .0;
    if accounts.swap_dvp != expected {
        return Err(ConfidentialError::Account("Create swap address").into());
    }
    let seed = derive_shared_seed(&expected, mac)?;
    let keys = EscrowKeys::from_seed(&seed)?;
    let session = create_session(config, accounts, args, &keys, amount_b)?;
    Ok((session, seed))
}

/// After Create confirms, fetch swap + escrow together and check them before
/// asking your SPL Token-2022 wallet to transfer B into the escrow. Compare all
/// public terms with the agreed deal too. The returned CT state provides the
/// recipient ElGamal key for the wallet's transfer proof generation.
/// Funding is an ordinary SPL transfer, independent of the DvP client.
pub fn verify_before_funding(
    accounts: &CreateConfidentialDvp,
    swap: &Account,
    escrow: &Account,
    shared_seed: &[u8; 32],
    expected_amount_b: u64,
) -> Result<ConfidentialTransferAccount, ConfidentialError> {
    let keys = EscrowKeys::from_seed(shared_seed)?;
    let (_, state) = verify_confidential_funding(
        &accounts.swap_dvp,
        swap,
        &accounts.dvp_ata_b,
        escrow,
        &keys,
        expected_amount_b,
    )?;
    Ok(state)
}

/// After funding confirms, refresh the escrow snapshot. An empty history works
/// when its AE balance is valid and pending limbs are directly decodable; otherwise
/// supply verified BalanceHistory events through this exact snapshot.
pub fn apply(
    config: &SessionConfig,
    accounts: &ApplyConfidentialDvp,
    args: ApplyConfidentialDvpInstructionArgs,
    escrow: &Account,
    keys: &EscrowKeys,
    history: &[BalanceEvent],
) -> Result<TransactionSession, ConfidentialError> {
    let (state, _) = read_escrow_account(
        &accounts.dvp_ata_b,
        &escrow.owner,
        &escrow.data,
        &accounts.swap_dvp,
        &args.mint_b,
    )?;
    apply_session(
        config,
        accounts,
        args,
        TransferSource {
            state: &state,
            keys,
            history,
        },
    )
}
