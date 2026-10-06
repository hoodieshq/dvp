use crate::{
    confidential_utils::{
        pending, set_mint_auditor, state, ConfidentialDvpFixture, Keys, MAX_PENDING,
    },
    state_utils::{AMOUNT_A, AMOUNT_B},
    utils::{execute, get_token_balance, ClientFixture, TestContext},
};
use dvp_swap_program_client::confidential::*;

#[test]
fn client_settle_exact_and_surplus_in_both_formats() {
    // Arbitrary nonzero limbs exercise both halves of payment and surplus.
    const PAYMENT_WITH_HIGH_LIMB: u64 = (3 << AMOUNT_LO_BITS) + 42;
    const SURPLUS_WITH_HIGH_LIMB: u64 = (1 << AMOUNT_LO_BITS) + 1;

    for format in [TransactionFormat::V1, TransactionFormat::V0] {
        for (amount_b, surplus, with_auditor) in [
            (AMOUNT_B, 0, false),
            (PAYMENT_WITH_HIGH_LIMB, SURPLUS_WITH_HIGH_LIMB, true),
        ] {
            // Fund the payment and optional surplus; exercise nonzero high limbs with an auditor.
            let mut context = TestContext::new();
            let fixture = ConfidentialDvpFixture::new(&mut context, true, false);
            let f = ClientFixture::with_fixture(
                &mut context,
                format,
                amount_b + surplus,
                fixture,
                amount_b,
                false,
                MAX_PENDING,
            );
            let auditor_keys = Keys::new();
            if with_auditor {
                set_mint_auditor(
                    &mut context,
                    &f.dvp.accounts.mint_b,
                    auditor_keys.elgamal.pubkey(),
                );
            }
            let mint_account = context.get_account(&f.dvp.accounts.mint_b).unwrap();
            let auditor = mint_auditor(&mint_account.owner, &mint_account.data).unwrap();
            let source = f.source(&context);
            let swap = f.swap(&context);
            let recipient = state(&context, &f.recipient);
            let refund = state(&context, &f.refund);

            // Build proofs and check that v0 uses Record storage and address lookups.
            let session = settle_session(
                &f.config,
                f.settle_accounts(),
                SettleRequest {
                    source: TransferSource {
                        state: &source,
                        keys: &f.keys,
                        history: &[],
                    },
                    swap: &swap,
                    expected_amount_b: amount_b,
                    recipient: &recipient,
                    surplus_recipient: &refund,
                    auditor: auditor.as_ref(),
                },
                &[],
                &[],
            )
            .unwrap();
            assert!(!session.preparation.is_empty());
            if format == TransactionFormat::V0 {
                assert!(session
                    .preparation
                    .iter()
                    .flat_map(|p| &p.instructions)
                    .any(|ix| ix.program_id == RECORD_PROGRAM_ID));
                assert!(!session
                    .final_transaction
                    .message(&f.config, context.svm.latest_blockhash())
                    .unwrap()
                    .address_table_lookups()
                    .unwrap()
                    .is_empty());
            }

            // Settle both legs and verify recipient balances and escrow closure.
            let history = execute(&mut context, &f.config, session, &[&f.dvp.authority]);
            assert!(context.get_account(&f.dvp.accounts.swap_dvp).is_none());
            assert!(context.get_account(&f.dvp.accounts.dvp_ata_b).is_none());
            assert_eq!(get_token_balance(&context, &f.asset_recipient), AMOUNT_A);
            assert_eq!(pending(&context, &f.recipient, &f.recipient_keys), amount_b);
            assert_eq!(pending(&context, &f.refund, &f.buyer_keys), surplus);

            // Decode the actual preparation transactions and DvP Token CPIs.
            let mut replay = BalanceHistory::new(f.recipient);
            for transaction in &history {
                replay.push(transaction).unwrap();
            }
            assert!(matches!(replay.events(), [BalanceEvent::Credit { .. }]));

            // Recover the recipient's pending balance and compare it with the payment.
            let keys = EscrowKeys {
                elgamal: f.recipient_keys.elgamal.clone(),
                ae: f.recipient_keys.ae.clone(),
                opening_lo: f.keys.opening_lo.clone(),
                opening_hi: f.keys.opening_hi.clone(),
            };
            let recovered =
                recover_escrow_balance(&state(&context, &f.recipient), 0, &keys, replay.events())
                    .unwrap();
            assert_eq!(recovered.pending, amount_b);
        }
    }
}

#[test]
fn client_settle_credits_payment_and_surplus_to_the_same_recipient() {
    let mut context = TestContext::new();
    let f = combined_recipient_fixture(&mut context, 2);

    // Payment and surplus consume two pending credits on the same account.
    let session = combined_recipient_session(&context, &f).unwrap();
    execute(&mut context, &f.config, session, &[&f.dvp.authority]);
    assert_eq!(pending(&context, &f.refund, &f.buyer_keys), AMOUNT_B + 7);
    assert_eq!(
        u64::from(state(&context, &f.refund).pending_balance_credit_counter),
        2
    );
    assert!(context.get_account(&f.dvp.accounts.swap_dvp).is_none());
}

#[test]
fn settle_rejects_wrong_amount_or_keys() {
    let mut context = TestContext::new();
    let f = ClientFixture::new(&mut context, TransactionFormat::V1, AMOUNT_B);
    let source = f.source(&context);
    let swap = f.swap(&context);
    let recipient = state(&context, &f.recipient);
    let refund = state(&context, &f.refund);
    let build = |keys, expected_amount_b| {
        settle_session(
            &f.config,
            f.settle_accounts(),
            SettleRequest {
                source: TransferSource {
                    state: &source,
                    keys,
                    history: &[],
                },
                swap: &swap,
                expected_amount_b,
                recipient: &recipient,
                surplus_recipient: &refund,
                auditor: None,
            },
            &[],
            &[],
        )
    };

    assert!(matches!(
        build(&f.keys, AMOUNT_B + 1),
        Err(ConfidentialError::AmountMismatch)
    ));
    let wrong_keys = EscrowKeys::from_seed(&[23; 32]).unwrap();
    assert!(matches!(
        build(&wrong_keys, AMOUNT_B),
        Err(ConfidentialError::Account("escrow ElGamal key"))
    ));
}

#[test]
fn settle_rejects_insufficient_combined_recipient_capacity() {
    let mut context = TestContext::new();
    let f = combined_recipient_fixture(&mut context, 1);

    assert!(matches!(
        combined_recipient_session(&context, &f),
        Err(ConfidentialError::RecipientPendingCounterFull { required: 2 })
    ));
    assert_eq!(pending(&context, &f.refund, &f.buyer_keys), 0);
}

fn combined_recipient_fixture(context: &mut TestContext, capacity: u64) -> ClientFixture {
    use solana_signer::Signer;
    let mut fixture = ConfidentialDvpFixture::new(context, true, false);
    fixture.args.user_a_settlement_destination = Some(fixture.user_b.pubkey());
    let mut f = ClientFixture::with_fixture(
        context,
        TransactionFormat::V1,
        AMOUNT_B + 7,
        fixture,
        AMOUNT_B,
        false,
        capacity,
    );
    f.recipient = f.refund;
    f
}

fn combined_recipient_session(
    context: &TestContext,
    f: &ClientFixture,
) -> Result<TransactionSession, ConfidentialError> {
    let source = f.source(context);
    let recipient = state(context, &f.refund);
    let swap = f.swap(context);
    settle_session(
        &f.config,
        f.settle_accounts(),
        SettleRequest {
            source: TransferSource {
                state: &source,
                keys: &f.keys,
                history: &[],
            },
            swap: &swap,
            expected_amount_b: AMOUNT_B,
            recipient: &recipient,
            surplus_recipient: &recipient,
            auditor: None,
        },
        &[],
        &[],
    )
}
