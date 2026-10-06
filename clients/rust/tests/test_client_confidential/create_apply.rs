use crate::state_utils::AMOUNT_B;
use crate::utils::{ClientFixture, TestContext};
use dvp_swap_program_client::{confidential::*, verify::verify_confidential_funding};

#[test]
fn client_create_apply_and_verify_in_both_formats() {
    for format in [TransactionFormat::V1, TransactionFormat::V0] {
        // Create the swap, fund escrow B, and apply its pending balance.
        let mut context = TestContext::new();
        let f = ClientFixture::new(&mut context, format, AMOUNT_B);
        let state = f.source(&context);
        let raw = context.get_account(&f.dvp.accounts.dvp_ata_b).unwrap();
        let raw_swap = context.get_account(&f.dvp.accounts.swap_dvp).unwrap();

        // Verify the funded accounts and applied balance.
        let (terms, checked_ct) = verify_confidential_funding(
            &f.dvp.accounts.swap_dvp,
            &raw_swap,
            &f.dvp.accounts.dvp_ata_b,
            &raw,
            &f.keys,
            AMOUNT_B,
        )
        .unwrap();
        assert_eq!(terms, f.swap(&context));
        assert_eq!(checked_ct, state);
        assert_eq!(
            read_escrow_account(
                &f.dvp.accounts.dvp_ata_b,
                &raw.owner,
                &raw.data,
                &f.dvp.accounts.swap_dvp,
                &f.dvp.accounts.mint_b
            )
            .unwrap()
            .0,
            state
        );
        verify_confidential_swap(&f.swap(&context), &state, &f.keys, AMOUNT_B).unwrap();
        let balance = read_escrow_balance(&state, 0, &f.keys, &[]).unwrap();
        assert_eq!(balance.available, AMOUNT_B);
        assert_eq!(balance.pending, 0);
    }
}

#[test]
fn escrow_account_rejects_wrong_owner_or_address() {
    let mut context = TestContext::new();
    let f = ClientFixture::new(&mut context, TransactionFormat::V1, 0);
    let raw = context.get_account(&f.dvp.accounts.dvp_ata_b).unwrap();

    // Keep valid escrow data and change only its owner or address.
    assert!(matches!(
        read_escrow_account(
            &f.dvp.accounts.dvp_ata_b,
            &f.config.payer,
            &raw.data,
            &f.dvp.accounts.swap_dvp,
            &f.dvp.accounts.mint_b
        ),
        Err(ConfidentialError::Account("escrow owner or address"))
    ));
    assert!(matches!(
        read_escrow_account(
            &f.refund,
            &raw.owner,
            &raw.data,
            &f.dvp.accounts.swap_dvp,
            &f.dvp.accounts.mint_b
        ),
        Err(ConfidentialError::Account("escrow owner or address"))
    ));
}

#[test]
fn confidential_swap_rejects_wrong_amount_or_keys() {
    let mut context = TestContext::new();
    let f = ClientFixture::new(&mut context, TransactionFormat::V1, AMOUNT_B);
    let state = f.source(&context);
    let swap = f.swap(&context);

    assert!(matches!(
        verify_confidential_swap(&swap, &state, &f.keys, AMOUNT_B + 1),
        Err(ConfidentialError::AmountMismatch)
    ));
    let wrong_keys = EscrowKeys::from_seed(&[0x43; 32]).unwrap();
    assert!(matches!(
        verify_confidential_swap(&swap, &state, &wrong_keys, AMOUNT_B),
        Err(ConfidentialError::AmountMismatch)
    ));
}

#[test]
fn funding_verification_rejects_wrong_escrow_address() {
    let mut context = TestContext::new();
    let f = ClientFixture::new(&mut context, TransactionFormat::V1, AMOUNT_B);
    let raw = context.get_account(&f.dvp.accounts.dvp_ata_b).unwrap();
    let raw_swap = context.get_account(&f.dvp.accounts.swap_dvp).unwrap();

    // Substitute the refund address while keeping valid escrow data.
    assert!(matches!(
        verify_confidential_funding(
            &f.dvp.accounts.swap_dvp,
            &raw_swap,
            &f.refund,
            &raw,
            &f.keys,
            AMOUNT_B
        ),
        Err(ConfidentialError::Account("escrow owner or address"))
    ));
}
