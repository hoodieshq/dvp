//! Representative guards between public and confidential account layouts.
use crate::{
    state_utils::{
        assert_create_dvp, assert_reject_dvp, setup_dvp, setup_dvp_with_programs, DvpFixture,
    },
    utils::{assert_program_error, TestContext, MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID},
};
use dvp_swap_program_client::{
    instructions::{ReclaimConfidentialDvpBuilder, ReclaimDvpBuilder, RecoverDvpBuilder},
    types::LegBrefund,
    DvpSwapProgramError,
};
use solana_signer::Signer;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::ConfidentialTransferAccount, BaseStateWithExtensionsMut,
        ExtensionType, PodStateWithExtensionsMut,
    },
    pod::{PodAccount, PodCOption},
    state::{Account as TokenAccount, AccountState},
};

#[test]
fn public_reclaim_rejects_confidential_swap() {
    let mut context = TestContext::new();
    let f = setup_dvp(&mut context, 0);
    assert_create_dvp(&mut context, &f);
    let mut swap = context.get_account(&f.swap_dvp).unwrap();
    // The confidential layout adds two 64-byte ciphertexts to the public base.
    swap.data.extend_from_slice(&[0; 64 * 2]);
    swap.lamports = context
        .svm
        .minimum_balance_for_rent_exemption(swap.data.len());
    context.svm.set_account(f.swap_dvp, swap.clone()).unwrap();
    let ix = ReclaimDvpBuilder::new()
        .signer(f.user_a.pubkey())
        .swap_dvp(f.swap_dvp)
        .mint(f.mint_a)
        .dvp_source_ata(f.dvp_ata_a)
        .signer_dest_ata(f.user_a_ata_a)
        .token_program(f.token_program_a)
        .memo_program(MEMO_PROGRAM_ID)
        .instruction();
    assert_program_error(
        context.send(ix, &[&f.user_a]),
        DvpSwapProgramError::SwapModeMismatch as u32,
    );
    assert_eq!(context.get_account(&f.swap_dvp).unwrap(), swap);
}

#[test]
fn confidential_reclaim_rejects_public_swap() {
    let mut context = TestContext::new();
    let f = setup_dvp(&mut context, 0);
    assert_create_dvp(&mut context, &f);
    let before = context.get_account(&f.swap_dvp);
    let ix = ReclaimConfidentialDvpBuilder::new()
        .signer(f.user_a.pubkey())
        .swap_dvp(f.swap_dvp)
        .mint(f.mint_a)
        .dvp_source_ata(f.dvp_ata_a)
        .signer_dest_ata(f.user_a_ata_a)
        .token_program(f.token_program_a)
        .memo_program(MEMO_PROGRAM_ID)
        .zk_elgamal_proof_program(solana_sdk_ids::zk_elgamal_proof_program::ID)
        .leg_b_refund(LegBrefund::None)
        .instruction();
    assert_program_error(
        context.send(ix, &[&f.user_a]),
        DvpSwapProgramError::SwapModeMismatch as u32,
    );
    assert_eq!(context.get_account(&f.swap_dvp), before);
}

fn set_ct_escrow(context: &mut TestContext, f: &DvpFixture) {
    let len = ExtensionType::try_calculate_account_len::<TokenAccount>(&[
        ExtensionType::ConfidentialTransferAccount,
    ])
    .unwrap();
    let mut data = vec![0; len];
    let mut state =
        PodStateWithExtensionsMut::<PodAccount>::unpack_uninitialized(&mut data).unwrap();
    state
        .init_extension::<ConfidentialTransferAccount>(true)
        .unwrap();
    *state.base = PodAccount {
        mint: f.mint_a,
        owner: f.swap_dvp,
        amount: 0.into(),
        delegate: PodCOption::none(),
        state: AccountState::Initialized as u8,
        is_native: PodCOption::none(),
        delegated_amount: 0.into(),
        close_authority: PodCOption::none(),
    };
    state.init_account_type().unwrap();
    context
        .svm
        .set_account(
            f.dvp_ata_a,
            solana_account::Account {
                lamports: 20_000_000,
                data,
                owner: TOKEN_2022_PROGRAM_ID,
                executable: false,
                rent_epoch: 0,
            },
        )
        .unwrap();
}

#[test]
fn public_recover_rejects_confidential_escrow() {
    let mut context = TestContext::new();
    let f = setup_dvp_with_programs(
        &mut context,
        0,
        TOKEN_2022_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID,
    );
    assert_create_dvp(&mut context, &f);
    assert_reject_dvp(&mut context, &f, &f.user_a);
    set_ct_escrow(&mut context, &f);
    let before = context.get_account(&f.dvp_ata_a);
    let ix = RecoverDvpBuilder::new()
        .signer(f.user_a.pubkey())
        .swap_dvp(f.swap_dvp)
        .nonce_tombstone(f.nonce_tombstone)
        .mint(f.mint_a)
        .dvp_escrow_ata(f.dvp_ata_a)
        .signer_dest_ata(f.user_a_ata_a)
        .token_program(f.token_program_a)
        .memo_program(MEMO_PROGRAM_ID)
        .settlement_authority(f.settlement_authority.pubkey())
        .user_a(f.user_a.pubkey())
        .user_b(f.user_b.pubkey())
        .mint_a(f.mint_a)
        .mint_b(f.mint_b)
        .nonce(f.nonce)
        .instruction();
    assert_program_error(
        context.send(ix, &[&f.user_a]),
        DvpSwapProgramError::SwapModeMismatch as u32,
    );
    assert_eq!(context.get_account(&f.dvp_ata_a), before);
}
