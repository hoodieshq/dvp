use super::*;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use solana_pubkey::Pubkey;
use solana_zk_sdk::encryption::elgamal::ElGamalCiphertext;
use spl_token_2022_interface::extension::confidential_transfer::ConfidentialTransferAccount;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn unhex(text: &str) -> Vec<u8> {
    text.as_bytes()
        .chunks_exact(2)
        .map(|b| u8::from_str_radix(std::str::from_utf8(b).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn shared_key_and_amount_vectors() {
    let vector: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test-vectors/confidential-amount-b.json"
    ))
    .unwrap();
    let master = unhex(vector["master_key"].as_str().unwrap());
    let swap: Pubkey = vector["swap_pda"].as_str().unwrap().parse().unwrap();
    let seed = derive_shared_seed(&swap, |message| -> Result<[u8; 32], ()> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&master).unwrap();
        mac.update(message);
        Ok(mac.finalize().into_bytes().into())
    })
    .unwrap();
    assert_eq!(hex(&seed), vector["shared_seed"]);
    let keys = EscrowKeys::from_seed(&seed).unwrap();
    let secret: [u8; 32] = keys.elgamal.secret().into();
    let ae: [u8; 16] = (&keys.ae).into();
    for (bytes, field) in [
        (&keys.elgamal.pubkey().to_bytes()[..], "elgamal_public_key"),
        (&secret[..], "elgamal_secret_key"),
        (&ae[..], "ae_key"),
        (&keys.opening_lo.to_bytes()[..], "opening_lo"),
        (&keys.opening_hi.to_bytes()[..], "opening_hi"),
    ] {
        assert_eq!(hex(bytes), vector[field]);
    }
    for case in vector["amounts"].as_array().unwrap() {
        let amount: u64 = case["amount"].as_str().unwrap().parse().unwrap();
        let encrypted = keys.encrypt_amount(amount).unwrap();
        assert_eq!(hex(&encrypted.lo), case["ciphertext_lo"]);
        assert_eq!(hex(&encrypted.hi), case["ciphertext_hi"]);
        for (bytes, limb) in [
            (&encrypted.lo, amount & ((1 << AMOUNT_LO_BITS) - 1)),
            (&encrypted.hi, amount >> AMOUNT_LO_BITS),
        ] {
            assert!(ciphertext_matches(
                &ElGamalCiphertext::from_bytes(bytes).unwrap(),
                &keys,
                limb
            ));
        }
    }
    for amount in [0, MAX_TRANSFER_AMOUNT + 1, u64::MAX] {
        assert!(matches!(
            keys.encrypt_amount(amount),
            Err(ConfidentialError::InvalidAmount)
        ));
    }
    let mut changed = seed;
    changed[0] ^= 1;
    assert_ne!(
        EscrowKeys::from_seed(&changed)
            .unwrap()
            .encrypt_amount(1)
            .unwrap(),
        keys.encrypt_amount(1).unwrap()
    );
}

#[test]
fn recover_false_and_corrupt_ae_balances_above_u32() {
    let keys = EscrowKeys::from_seed(&[7; 32]).unwrap();
    let credit = (1u64 << 47) + 65_535;
    let encrypted = keys.encrypt_amount(credit).unwrap();
    let lo = ElGamalCiphertext::from_bytes(&encrypted.lo).unwrap();
    let hi = ElGamalCiphertext::from_bytes(&encrypted.hi).unwrap();
    let mut state = ConfidentialTransferAccount {
        elgamal_pubkey: (*keys.elgamal.pubkey()).into(),
        pending_balance_lo: (lo + lo + lo).into(),
        pending_balance_hi: (hi + hi + hi).into(),
        pending_balance_credit_counter: 3.into(),
        decryptable_available_balance: keys.ae.encrypt(0).into(),
        ..Default::default()
    };
    let mut history = vec![BalanceEvent::Credit { lo, hi }; 3];
    // The sum of the high limbs exceeds the SDK's u32 discrete-log limit.
    let recovered = read_escrow_balance(&state, 11, &keys, &history).unwrap();
    assert_eq!(recovered.pending, credit * 3);
    assert_eq!(recovered.public, 11);
    state.available_balance = keys.elgamal.pubkey().encrypt(credit * 3).into();
    state.pending_balance_lo = Default::default();
    state.pending_balance_hi = Default::default();
    state.pending_balance_credit_counter = 0.into();
    history.push(BalanceEvent::Apply);
    for ae in [keys.ae.encrypt(1).into(), Default::default()] {
        state.decryptable_available_balance = ae;
        assert!(matches!(
            checked_available_balance(&state, &keys),
            Err(ConfidentialError::BalanceMismatch)
        ));
        assert_eq!(
            read_escrow_balance(&state, 11, &keys, &history)
                .unwrap()
                .available,
            credit * 3
        );
        assert!(read_escrow_balance(&state, 11, &keys, &history[1..]).is_err());
    }
    // A correct AE value works above u32 without replay or a discrete log.
    state.decryptable_available_balance = keys.ae.encrypt(credit * 3).into();
    assert_eq!(
        read_escrow_balance(&state, 0, &keys, &[])
            .unwrap()
            .available,
        credit * 3
    );
}

#[test]
fn history_skips_failed_transactions_and_rejects_missing_context() {
    let escrow = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let equality = Pubkey::new_unique();
    let validity = Pubkey::new_unique();
    let range = Pubkey::new_unique();
    use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
    let instructions =
        spl_token_2022_interface::extension::confidential_transfer::instruction::transfer(
            &spl_token_2022_interface::ID,
            &source,
            &mint,
            &escrow,
            &Default::default(),
            &Default::default(),
            &Default::default(),
            &authority,
            &[],
            ProofLocation::ContextStateAccount(&equality),
            ProofLocation::ContextStateAccount(&validity),
            ProofLocation::ContextStateAccount(&range),
        )
        .unwrap();
    let mut transaction = ExecutedTransaction {
        instructions,
        inner_instructions: Default::default(),
        succeeded: false,
    };
    let mut history = BalanceHistory::new(escrow);
    history.push(&transaction).unwrap();
    assert!(history.events().is_empty());
    transaction.succeeded = true;
    assert!(matches!(
        history.push(&transaction),
        Err(ConfidentialError::IncompleteHistory)
    ));
}

#[test]
fn oversized_plan_returns_an_error() {
    let config = SessionConfig::new(
        Pubkey::new_unique(),
        TransactionFormat::V0,
        Default::default(),
    );
    let plan = PlannedTransaction {
        instructions: vec![solana_instruction::Instruction {
            program_id: Pubkey::new_unique(),
            accounts: vec![],
            data: vec![0; config.transaction_limit()],
        }],
        signers: vec![],
    };
    assert!(matches!(
        plan.message(&config, Default::default()),
        Err(ConfidentialError::TransactionTooLarge { .. })
    ));
}

#[test]
fn payer_and_authority_can_use_the_same_signer() {
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    let wallet = Keypair::new();
    let plan = PlannedTransaction {
        signers: vec![],
        instructions: vec![solana_system_interface::instruction::transfer(
            &wallet.pubkey(),
            &Pubkey::new_unique(),
            1,
        )],
    };
    for format in [TransactionFormat::V1, TransactionFormat::V0] {
        let config = SessionConfig::new(wallet.pubkey(), format, Default::default());
        let tx = plan
            .sign(&config, Default::default(), &[&wallet, &wallet])
            .unwrap();
        tx.sanitize().unwrap();
        assert_eq!(tx.signatures.len(), 1);
        assert_ne!(tx.signatures[0], Default::default());
    }
}

#[test]
fn truncated_record_history_returns_an_error() {
    use solana_instruction::{AccountMeta, Instruction};
    let write = spl_record::instruction::RecordInstruction::Write {
        offset: 0,
        data: &[7; 8],
    }
    .pack();
    for len in [1, 8, write.len() - 1] {
        let mut history = BalanceHistory::new(Pubkey::new_unique());
        let transaction = ExecutedTransaction {
            instructions: vec![Instruction {
                program_id: RECORD_PROGRAM_ID,
                accounts: vec![AccountMeta::new(Pubkey::new_unique(), false)],
                data: write[..len].to_vec(),
            }],
            inner_instructions: Default::default(),
            succeeded: true,
        };
        assert!(matches!(
            history.push(&transaction),
            Err(ConfidentialError::IncompleteHistory)
        ));
    }
}

#[test]
fn history_decodes_inline_and_record_validity_proofs() {
    use solana_instruction::{AccountMeta, Instruction};
    use solana_zk_elgamal_proof_interface::instruction::{ContextStateInfo, ProofInstruction};
    use solana_zk_sdk::{
        encryption::grouped_elgamal::GroupedElGamal,
        zk_elgamal_proof_program::build_batched_grouped_ciphertext_3_handles_validity_proof_data,
    };
    use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
    let source_keys = EscrowKeys::from_seed(&[1; 32]).unwrap();
    let keys = EscrowKeys::from_seed(&[2; 32]).unwrap();
    let auditor = EscrowKeys::from_seed(&[3; 32]).unwrap();
    let pubkeys = [
        source_keys.elgamal.pubkey(),
        keys.elgamal.pubkey(),
        auditor.elgamal.pubkey(),
    ];
    let grouped_lo = GroupedElGamal::encrypt_with(pubkeys, 42u64, &keys.opening_lo);
    let grouped_hi = GroupedElGamal::encrypt_with(pubkeys, 3u64, &keys.opening_hi);
    let proof = build_batched_grouped_ciphertext_3_handles_validity_proof_data(
        pubkeys[0],
        pubkeys[1],
        pubkeys[2],
        &grouped_lo,
        &grouped_hi,
        42,
        3,
        &keys.opening_lo,
        &keys.opening_hi,
    )
    .unwrap();
    let escrow = Pubkey::new_unique();
    let source = Pubkey::new_unique();
    let mint = Pubkey::new_unique();
    let authority = Pubkey::new_unique();
    let equality = Pubkey::new_unique();
    let validity = Pubkey::new_unique();
    let range = Pubkey::new_unique();
    let transfer = |location| {
        spl_token_2022_interface::extension::confidential_transfer::instruction::transfer(
            &spl_token_2022_interface::ID,
            &source,
            &mint,
            &escrow,
            &Default::default(),
            &Default::default(),
            &Default::default(),
            &authority,
            &[],
            ProofLocation::ContextStateAccount(&equality),
            location,
            ProofLocation::ContextStateAccount(&range),
        )
        .unwrap()
    };
    let inline = transfer(ProofLocation::InstructionOffset(
        std::num::NonZeroI8::new(1).unwrap(),
        &proof,
    ));
    let record = Pubkey::new_unique();
    let record_ix = |instruction: spl_record::instruction::RecordInstruction<'_>| Instruction {
        program_id: RECORD_PROGRAM_ID,
        accounts: vec![AccountMeta::new(record, false)],
        data: instruction.pack(),
    };
    let bytes = bytemuck::bytes_of(&proof);
    let split = bytes.len() / 2;
    let mut staged = vec![
        record_ix(spl_record::instruction::RecordInstruction::Initialize),
        record_ix(spl_record::instruction::RecordInstruction::Write {
            offset: 0,
            data: &bytes[..split],
        }),
        record_ix(spl_record::instruction::RecordInstruction::Write {
            offset: split as u64,
            data: &bytes[split..],
        }),
        ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity
            .encode_verify_proof_from_account(
                Some(ContextStateInfo {
                    context_state_account: &validity,
                    context_state_authority: &authority,
                }),
                &record,
                spl_record::state::RecordData::WRITABLE_START_INDEX as u32,
            ),
    ];
    staged.extend(transfer(ProofLocation::ContextStateAccount(&validity)));
    staged.push(record_ix(
        spl_record::instruction::RecordInstruction::CloseAccount,
    ));
    let state = ConfidentialTransferAccount {
        elgamal_pubkey: (*keys.elgamal.pubkey()).into(),
        pending_balance_lo: grouped_lo.to_elgamal_ciphertext(1).unwrap().into(),
        pending_balance_hi: grouped_hi.to_elgamal_ciphertext(1).unwrap().into(),
        pending_balance_credit_counter: 1.into(),
        decryptable_available_balance: keys.ae.encrypt(0).into(),
        ..Default::default()
    };
    for instructions in [inline, staged] {
        let mut history = BalanceHistory::new(escrow);
        history
            .push(&ExecutedTransaction {
                instructions,
                inner_instructions: Default::default(),
                succeeded: true,
            })
            .unwrap();
        assert_eq!(
            recover_escrow_balance(&state, 0, &keys, history.events())
                .unwrap()
                .pending,
            (3 << AMOUNT_LO_BITS) + 42
        );
    }
}

#[test]
fn v1_rejects_too_many_addresses_before_signing() {
    use solana_instruction::{AccountMeta, Instruction};
    use solana_keypair::Keypair;
    use solana_signer::Signer;
    let payer = Keypair::new();
    let config = SessionConfig::new(payer.pubkey(), TransactionFormat::V1, Default::default());
    let mut plan = PlannedTransaction {
        instructions: vec![Instruction {
            program_id: Pubkey::new_unique(),
            accounts: (0..64)
                .map(|_| AccountMeta::new_readonly(Pubkey::new_unique(), false))
                .collect(),
            data: vec![],
        }],
        signers: vec![],
    };
    assert!(matches!(
        plan.wire_size(&config),
        Err(ConfidentialError::Transaction(_))
    ));
    assert!(matches!(
        plan.sign(&config, Default::default(), &[&payer]),
        Err(ConfidentialError::Transaction(_))
    ));
    plan.instructions[0].accounts.truncate(62);
    let tx = plan.sign(&config, Default::default(), &[&payer]).unwrap();
    assert_eq!(tx.message.static_account_keys().len(), 64);
    tx.sanitize().unwrap();
}

#[test]
fn outgoing_preflight_reports_balance_and_recipient_errors() {
    let keys = EscrowKeys::from_seed(&[21; 32]).unwrap();
    let config = SessionConfig::new(
        Pubkey::new_unique(),
        TransactionFormat::V1,
        Default::default(),
    );
    let source = ConfidentialTransferAccount {
        elgamal_pubkey: (*keys.elgamal.pubkey()).into(),
        available_balance: keys.elgamal.pubkey().encrypt(10u64).into(),
        decryptable_available_balance: keys.ae.encrypt(10).into(),
        ..Default::default()
    };
    let recipient = ConfidentialTransferAccount {
        elgamal_pubkey: (*keys.elgamal.pubkey()).into(),
        approved: true.into(),
        allow_confidential_credits: true.into(),
        maximum_pending_balance_credit_counter: 1.into(),
        ..Default::default()
    };
    let build = |recipient: &ConfidentialTransferAccount, amount| {
        transfer_session(
            &config,
            TransferAccounts {
                authority: config.payer,
                source: Pubkey::new_unique(),
                mint: Pubkey::new_unique(),
                destination: Pubkey::new_unique(),
            },
            TransferRequest {
                source: TransferSource {
                    state: &source,
                    keys: &keys,
                    history: &[],
                },
                recipient,
                amount,
                auditor: None,
            },
            &[],
        )
    };
    assert!(matches!(
        build(&recipient, 11),
        Err(ConfidentialError::InsufficientAvailable {
            available: 10,
            required: 11
        })
    ));
    assert!(matches!(
        build(&recipient, MAX_TRANSFER_AMOUNT + 1),
        Err(ConfidentialError::TransferAmountTooLarge(_))
    ));
    let mut invalid = recipient;
    invalid.approved = false.into();
    assert!(matches!(
        build(&invalid, 1),
        Err(ConfidentialError::RecipientNotApproved)
    ));
    invalid = recipient;
    invalid.allow_confidential_credits = false.into();
    assert!(matches!(
        build(&invalid, 1),
        Err(ConfidentialError::RecipientCreditsDisabled)
    ));
    invalid = recipient;
    invalid.pending_balance_credit_counter = 1.into();
    assert!(matches!(
        build(&invalid, 1),
        Err(ConfidentialError::RecipientPendingCounterFull { required: 1 })
    ));
}

#[cfg(feature = "fetch")]
#[test]
fn rpc_history_rejects_incomplete_or_malformed_metadata() {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use solana_instruction::{AccountMeta, Instruction};
    use solana_message::AddressLookupTableAccount;
    use solana_transaction::versioned::VersionedTransaction;
    use solana_transaction_status_client_types::EncodedTransactionWithStatusMeta;
    let looked_up = Pubkey::new_unique();
    let program = Pubkey::new_unique();
    let mut config = SessionConfig::new(
        Pubkey::new_unique(),
        TransactionFormat::V0,
        Default::default(),
    );
    config.lookup_tables.push(AddressLookupTableAccount {
        key: Pubkey::new_unique(),
        addresses: vec![looked_up],
    });
    let message = PlannedTransaction {
        instructions: vec![Instruction {
            program_id: program,
            accounts: vec![AccountMeta::new(looked_up, false)],
            data: vec![],
        }],
        signers: vec![],
    }
    .message(&config, Default::default())
    .unwrap();
    let program_index = message
        .static_account_keys()
        .iter()
        .position(|p| *p == program)
        .unwrap();
    let loaded_index = message.static_account_keys().len();
    let tx = VersionedTransaction {
        signatures: vec![Default::default(); message.header().num_required_signatures as usize],
        message,
    };
    let base = serde_json::json!({
        "transaction": [STANDARD.encode(wincode::serialize(&tx).unwrap()), "base64"],
        "meta": {"err": null, "status": {"Ok": null}, "fee": 0, "preBalances": [], "postBalances": [],
            "loadedAddresses": {"writable": [looked_up.to_string()], "readonly": []},
            "innerInstructions": [{"index": 2, "instructions": [{"programIdIndex": program_index, "accounts": [loaded_index], "data": ""}]}]}
    });
    let decode = |value| {
        ExecutedTransaction::from_rpc(
            &serde_json::from_value::<EncodedTransactionWithStatusMeta>(value).unwrap(),
        )
    };
    assert!(decode(base.clone()).is_ok());
    let mut cases = vec![];
    for field in ["loadedAddresses", "innerInstructions"] {
        let mut value = base.clone();
        value["meta"].as_object_mut().unwrap().remove(field);
        cases.push(value);
    }
    let mut value = base.clone();
    value["meta"] = serde_json::Value::Null;
    cases.push(value);
    let mut value = base.clone();
    value["meta"]["loadedAddresses"]["writable"] = serde_json::json!([]);
    cases.push(value);
    let mut value = base.clone();
    value["meta"]["loadedAddresses"]["writable"][0] = serde_json::json!("invalid address");
    cases.push(value);
    let mut value = base.clone();
    value["meta"]["innerInstructions"][0]["index"] = serde_json::json!(3);
    cases.push(value);
    let mut value = base.clone();
    let group = value["meta"]["innerInstructions"][0].clone();
    value["meta"]["innerInstructions"]
        .as_array_mut()
        .unwrap()
        .push(group);
    cases.push(value);
    let mut value = base.clone();
    value["meta"]["innerInstructions"][0]["instructions"][0]["accounts"] = serde_json::json!([255]);
    cases.push(value);
    let mut value = base.clone();
    value["meta"]["innerInstructions"][0]["instructions"][0] = serde_json::json!({"program": "system", "programId": program.to_string(), "parsed": {"type": "transfer"}});
    cases.push(value);
    for value in cases {
        assert!(matches!(
            decode(value),
            Err(ConfidentialError::IncompleteHistory)
        ));
    }
    let mut failed = base;
    failed["meta"]["err"] = serde_json::json!("AccountNotFound");
    assert!(!decode(failed).unwrap().succeeded);
}
