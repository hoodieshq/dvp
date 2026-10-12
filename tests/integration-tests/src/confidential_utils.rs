//! Real-proof setup for the PDA fixture. Key derivation and transaction packing
//! belong to the client stage; these tests use random keys and one proof per tx.
use std::{mem::size_of, num::NonZeroI8};

use litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use solana_instruction::{AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_message::{v1, VersionedMessage};
use solana_pubkey::{pubkey, Pubkey};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;
use solana_zk_elgamal_proof_interface::{
    instruction::{ContextStateInfo, ProofInstruction},
    proof_data::ZkProofData,
    state::ProofContextState,
};
use solana_zk_sdk::{
    encryption::{
        auth_encryption::AeKey,
        elgamal::{ElGamalCiphertext, ElGamalKeypair},
        pedersen::PedersenOpening,
    },
    zk_elgamal_proof_program::{
        build_ciphertext_ciphertext_equality_proof_data, build_pubkey_validity_proof_data,
        build_zero_ciphertext_proof_data,
    },
};
use solana_zk_sdk_pod::encryption::auth_encryption::PodAeCiphertext;
use spl_token_2022_interface::{
    extension::{
        confidential_transfer::{instruction as ct_ix, ConfidentialTransferAccount},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    instruction as token_ix,
    state::{Account as TokenAccount, Mint},
};
use spl_token_confidential_transfer_proof_extraction::instruction::ProofLocation;
use spl_token_confidential_transfer_proof_generation::{
    transfer::{transfer_split_proof_data, TransferProofData},
    try_combine_lo_hi_ciphertexts, try_split_u64,
};

use crate::utils::{
    create_ata, set_hook_extra_account_metas, TestContext, HOOK_FIXTURE_PROGRAM_ID,
    MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID as TOKEN,
};

pub const FIXTURE: Pubkey = pubkey!("FCDHD6mkL4c7hMLxdLy2a9aCjraYJJwpF6gnbukwHRV5");
pub use solana_zk_elgamal_proof_interface::ID as ZK;
pub const LO_BITS: usize = 16;
pub const MAX_PENDING: u64 = 65_536;
pub const DECIMALS: u8 = 6;

pub fn send_v1(
    context: &mut TestContext,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
    context.svm.expire_blockhash();
    // Agave v1 requires both limits explicitly; Token-2022 alone loads 1.3 MB.
    let config = v1::TransactionConfig::empty()
        .with_compute_unit_limit(400_000)
        .with_loaded_accounts_data_size_limit(4_000_000);
    let message = v1::Message::try_compile_with_config(
        &context.payer.pubkey(),
        instructions,
        context.svm.latest_blockhash(),
        config,
    )
    .unwrap();
    let mut all_signers = vec![&context.payer];
    all_signers.extend_from_slice(signers);
    let transaction =
        VersionedTransaction::try_new(VersionedMessage::V1(message), &all_signers).unwrap();
    assert!(wincode::serialize(&transaction).unwrap().len() <= 4096);
    context.svm.send_transaction(transaction).map_err(Box::new)
}

pub struct Keys {
    pub elgamal: ElGamalKeypair,
    pub ae: AeKey,
}
impl Keys {
    pub fn new() -> Self {
        Self {
            elgamal: ElGamalKeypair::new_rand(),
            ae: AeKey::new_rand(),
        }
    }
    pub fn balance(&self, amount: u64) -> PodAeCiphertext {
        self.ae.encrypt(amount).into()
    }
}

pub fn state(context: &TestContext, address: &Pubkey) -> ConfidentialTransferAccount {
    let account = context.get_account(address).unwrap();
    *StateWithExtensions::<TokenAccount>::unpack(&account.data)
        .unwrap()
        .get_extension::<ConfidentialTransferAccount>()
        .unwrap()
}

pub fn pending(context: &TestContext, address: &Pubkey, keys: &Keys) -> u64 {
    let state = state(context, address);
    let lo: ElGamalCiphertext = state.pending_balance_lo.try_into().unwrap();
    let hi: ElGamalCiphertext = state.pending_balance_hi.try_into().unwrap();
    lo.decrypt_u32(keys.elgamal.secret()).unwrap()
        + (hi.decrypt_u32(keys.elgamal.secret()).unwrap() << LO_BITS)
}

pub fn context_account<T: bytemuck::Pod + ZkProofData<U>, U: bytemuck::Pod>(
    context: &mut TestContext,
    authority: &Pubkey,
    instruction: ProofInstruction,
    proof: &T,
) -> Pubkey {
    let keypair = Keypair::new();
    let space = size_of::<ProofContextState<U>>();
    let instructions = [
        solana_system_interface::instruction::create_account(
            &context.payer.pubkey(),
            &keypair.pubkey(),
            context.svm.minimum_balance_for_rent_exemption(space),
            space as u64,
            &ZK,
        ),
        instruction.encode_verify_proof(
            Some(ContextStateInfo {
                context_state_account: &keypair.pubkey(),
                context_state_authority: authority,
            }),
            proof,
        ),
    ];
    send_v1(context, &instructions, &[&keypair]).unwrap();
    keypair.pubkey()
}

fn transfer_contexts(
    context: &mut TestContext,
    authority: &Pubkey,
    proof: &TransferProofData,
) -> [Pubkey; 3] {
    [
        context_account(
            context,
            authority,
            ProofInstruction::VerifyCiphertextCommitmentEquality,
            &proof.equality_proof_data,
        ),
        context_account(
            context,
            authority,
            ProofInstruction::VerifyBatchedGroupedCiphertext3HandlesValidity,
            &proof
                .ciphertext_validity_proof_data_with_ciphertext
                .proof_data,
        ),
        context_account(
            context,
            authority,
            ProofInstruction::VerifyBatchedRangeProofU128,
            &proof.range_proof_data,
        ),
    ]
}

fn create_wallet_account(
    context: &mut TestContext,
    wallet: &Keypair,
    mint: &Pubkey,
    keys: &Keys,
) -> Pubkey {
    let address = create_ata(context, &wallet.pubkey(), mint, &TOKEN);
    let proof = build_pubkey_validity_proof_data(&keys.elgamal).unwrap();
    let mut instructions = vec![token_ix::reallocate(
        &TOKEN,
        &address,
        &context.payer.pubkey(),
        &wallet.pubkey(),
        &[],
        &[ExtensionType::ConfidentialTransferAccount],
    )
    .unwrap()];
    instructions.extend(
        ct_ix::configure_account(
            &TOKEN,
            &address,
            mint,
            &keys.balance(0),
            MAX_PENDING,
            &wallet.pubkey(),
            &[],
            ProofLocation::InstructionOffset(NonZeroI8::new(1).unwrap(), &proof),
        )
        .unwrap(),
    );
    send_v1(context, &instructions, &[wallet]).unwrap();
    address
}

pub struct ConfidentialTransferTestContext {
    pub context: TestContext,
    pub mint: Pubkey,
    pub authority: Pubkey,
    pub escrow: Pubkey,
    pub escrow_keys: Keys,
    pub recipient: Keypair,
    pub destination: Pubkey,
    pub recipient_keys: Keys,
    pub proof_authority: Keypair,
    source_owner: Keypair,
    source: Pubkey,
    source_keys: Keys,
    pub extras: Vec<AccountMeta>,
}

impl ConfidentialTransferTestContext {
    pub fn new(amount: u64, hook: bool) -> Self {
        let mut context = TestContext::new();
        context
            .svm
            .add_program(
                FIXTURE,
                include_bytes!("../../../target/deploy/confidential_transfer_fixture.so"),
            )
            .unwrap();
        let mint = Keypair::new();
        let mut extensions = vec![ExtensionType::ConfidentialTransferMint];
        if hook {
            extensions.push(ExtensionType::TransferHook);
        }
        let space = ExtensionType::try_calculate_account_len::<Mint>(&extensions).unwrap();
        let mut instructions = vec![
            solana_system_interface::instruction::create_account(
                &context.payer.pubkey(),
                &mint.pubkey(),
                context.svm.minimum_balance_for_rent_exemption(space),
                space as u64,
                &TOKEN,
            ),
            ct_ix::initialize_mint(
                &TOKEN,
                &mint.pubkey(),
                Some(context.payer.pubkey()),
                true,
                None,
            )
            .unwrap(),
        ];
        if hook {
            instructions.push(
                spl_token_2022_interface::extension::transfer_hook::instruction::initialize(
                    &TOKEN,
                    &mint.pubkey(),
                    Some(context.payer.pubkey()),
                    Some(HOOK_FIXTURE_PROGRAM_ID),
                )
                .unwrap(),
            );
        }
        instructions.push(
            token_ix::initialize_mint(
                &TOKEN,
                &mint.pubkey(),
                &context.payer.pubkey(),
                None,
                DECIMALS,
            )
            .unwrap(),
        );
        send_v1(&mut context, &instructions, &[&mint]).unwrap();
        let mint = mint.pubkey();
        let source_owner = Keypair::new();
        let source_keys = Keys::new();
        let source = create_wallet_account(&mut context, &source_owner, &mint, &source_keys);
        let recipient = Keypair::new();
        let recipient_keys = Keys::new();
        let destination = create_wallet_account(&mut context, &recipient, &mint, &recipient_keys);
        let authority = Pubkey::find_program_address(&[b"ct-test"], &FIXTURE).0;
        let escrow = create_ata(&mut context, &authority, &mint, &TOKEN);
        let escrow_keys = Keys::new();
        let proof = build_pubkey_validity_proof_data(&escrow_keys.elgamal).unwrap();
        let mut data = vec![0];
        data.extend_from_slice(&escrow_keys.balance(0).0);
        data.push((-1i8) as u8);
        let instructions = [
            ProofInstruction::VerifyPubkeyValidity.encode_verify_proof(None, &proof),
            Instruction {
                program_id: FIXTURE,
                accounts: vec![
                    AccountMeta::new(context.payer.pubkey(), true),
                    AccountMeta::new_readonly(authority, false),
                    AccountMeta::new(escrow, false),
                    AccountMeta::new_readonly(mint, false),
                    AccountMeta::new_readonly(solana_sdk_ids::sysvar::instructions::ID, false),
                    AccountMeta::new_readonly(TOKEN, false),
                    AccountMeta::new_readonly(solana_sdk_ids::system_program::ID, false),
                ],
                data,
            },
        ];
        send_v1(&mut context, &instructions, &[]).unwrap();
        let mut ct_context = Self {
            context,
            mint,
            authority,
            escrow,
            escrow_keys,
            recipient,
            destination,
            recipient_keys,
            proof_authority: Keypair::new(),
            source_owner,
            source,
            source_keys,
            extras: vec![],
        };
        // Only the EAML is injected; mint and token accounts are created by their programs.
        if hook {
            ct_context.set_hook_extras(&[AccountMeta::new_readonly(
                solana_sdk_ids::system_program::ID,
                false,
            )]);
        }
        ct_context.fund(amount);
        let mut data = vec![1];
        data.extend_from_slice(&1u64.to_le_bytes());
        data.extend_from_slice(&ct_context.escrow_keys.balance(amount).0);
        let apply = Instruction {
            program_id: FIXTURE,
            accounts: vec![
                AccountMeta::new_readonly(authority, false),
                AccountMeta::new(escrow, false),
                AccountMeta::new_readonly(TOKEN, false),
            ],
            data,
        };
        send_v1(&mut ct_context.context, &[apply], &[]).unwrap();
        ct_context
    }

    pub fn set_hook_extras(&mut self, extras: &[AccountMeta]) {
        let address = set_hook_extra_account_metas(&mut self.context, &self.mint, extras);
        self.extras = extras.to_vec();
        self.extras.extend([
            AccountMeta::new_readonly(HOOK_FIXTURE_PROGRAM_ID, false),
            AccountMeta::new_readonly(address, false),
        ]);
    }

    /// Ordinary wallet CT funding, including a credit arriving after proof prep.
    pub fn fund(&mut self, amount: u64) {
        let before = state(&self.context, &self.source);
        let instructions = [
            token_ix::mint_to(
                &TOKEN,
                &self.mint,
                &self.source,
                &self.context.payer.pubkey(),
                &[],
                amount,
            )
            .unwrap(),
            ct_ix::deposit(
                &TOKEN,
                &self.source,
                &self.mint,
                amount,
                DECIMALS,
                &self.source_owner.pubkey(),
                &[],
            )
            .unwrap(),
            ct_ix::apply_pending_balance(
                &TOKEN,
                &self.source,
                u64::from(before.pending_balance_credit_counter) + 1,
                &self.source_keys.balance(amount),
                &self.source_owner.pubkey(),
                &[],
            )
            .unwrap(),
        ];
        send_v1(&mut self.context, &instructions, &[&self.source_owner]).unwrap();
        let source = state(&self.context, &self.source);
        let proof = transfer_split_proof_data(
            &source.available_balance.try_into().unwrap(),
            &source.decryptable_available_balance.try_into().unwrap(),
            amount,
            &self.source_keys.elgamal,
            &self.source_keys.ae,
            self.escrow_keys.elgamal.pubkey(),
            None,
        )
        .unwrap();
        let [equality, validity, range] =
            transfer_contexts(&mut self.context, &self.source_owner.pubkey(), &proof);
        let ciphertext = &proof.ciphertext_validity_proof_data_with_ciphertext;
        let mut instructions = ct_ix::transfer(
            &TOKEN,
            &self.source,
            &self.mint,
            &self.escrow,
            &self.source_keys.balance(0),
            &ciphertext.ciphertext_lo,
            &ciphertext.ciphertext_hi,
            &self.source_owner.pubkey(),
            &[],
            ProofLocation::ContextStateAccount(&equality),
            ProofLocation::ContextStateAccount(&validity),
            ProofLocation::ContextStateAccount(&range),
        )
        .unwrap();
        instructions[0].accounts.extend_from_slice(&self.extras);
        for account in [equality, validity, range] {
            instructions.push(
                solana_zk_elgamal_proof_interface::instruction::close_context_state(
                    ContextStateInfo {
                        context_state_account: &account,
                        context_state_authority: &self.source_owner.pubkey(),
                    },
                    &self.context.payer.pubkey(),
                ),
            );
        }
        send_v1(&mut self.context, &instructions, &[&self.source_owner]).unwrap();
    }

    /// A full payment with two independently encrypted stored amount limbs.
    pub fn prepare(&mut self, amount: u64) -> Payment {
        let source = state(&self.context, &self.escrow);
        let available: ElGamalCiphertext = source.available_balance.try_into().unwrap();
        let proof = transfer_split_proof_data(
            &available,
            &source.decryptable_available_balance.try_into().unwrap(),
            amount,
            &self.escrow_keys.elgamal,
            &self.escrow_keys.ae,
            self.recipient_keys.elgamal.pubkey(),
            None,
        )
        .unwrap();
        let authority = self.proof_authority.pubkey();
        let [equality, validity, range] = transfer_contexts(&mut self.context, &authority, &proof);
        let ciphertext = &proof.ciphertext_validity_proof_data_with_ciphertext;
        let validity_data = ciphertext.proof_data.context_data();
        let lo: ElGamalCiphertext = validity_data
            .grouped_ciphertext_lo
            .try_extract_ciphertext(0)
            .unwrap()
            .try_into()
            .unwrap();
        let hi: ElGamalCiphertext = validity_data
            .grouped_ciphertext_hi
            .try_extract_ciphertext(0)
            .unwrap()
            .try_into()
            .unwrap();
        let (amount_lo, amount_hi) = try_split_u64(amount, LO_BITS).unwrap();
        let opening_lo = PedersenOpening::new_rand();
        let opening_hi = PedersenOpening::new_rand();
        let stored_lo = self
            .escrow_keys
            .elgamal
            .pubkey()
            .encrypt_with(amount_lo, &opening_lo);
        let stored_hi = self
            .escrow_keys
            .elgamal
            .pubkey()
            .encrypt_with(amount_hi, &opening_hi);
        let eq_lo = build_ciphertext_ciphertext_equality_proof_data(
            &self.escrow_keys.elgamal,
            self.escrow_keys.elgamal.pubkey(),
            &lo,
            &stored_lo,
            &opening_lo,
            amount_lo,
        )
        .unwrap();
        let eq_hi = build_ciphertext_ciphertext_equality_proof_data(
            &self.escrow_keys.elgamal,
            self.escrow_keys.elgamal.pubkey(),
            &hi,
            &stored_hi,
            &opening_hi,
            amount_hi,
        )
        .unwrap();
        let eq_lo = context_account(
            &mut self.context,
            &authority,
            ProofInstruction::VerifyCiphertextCiphertextEquality,
            &eq_lo,
        );
        let eq_hi = context_account(
            &mut self.context,
            &authority,
            ProofInstruction::VerifyCiphertextCiphertextEquality,
            &eq_hi,
        );
        let remaining = available - try_combine_lo_hi_ciphertexts(&lo, &hi, LO_BITS).unwrap();
        let zero = build_zero_ciphertext_proof_data(&self.escrow_keys.elgamal, &remaining).unwrap();
        let zero = context_account(
            &mut self.context,
            &authority,
            ProofInstruction::VerifyZeroCiphertext,
            &zero,
        );
        let contexts = [eq_lo, eq_hi, equality, validity, range, zero];
        let mut data = vec![2];
        data.extend_from_slice(&self.escrow_keys.balance(0).0);
        data.extend_from_slice(&ciphertext.ciphertext_lo.0);
        data.extend_from_slice(&ciphertext.ciphertext_hi.0);
        data.extend_from_slice(&stored_lo.to_bytes());
        data.extend_from_slice(&stored_hi.to_bytes());
        let mut accounts = vec![
            AccountMeta::new_readonly(self.authority, false),
            AccountMeta::new(self.escrow, false),
            AccountMeta::new_readonly(self.mint, false),
            AccountMeta::new(self.destination, false),
            AccountMeta::new(authority, true),
        ];
        accounts.extend(contexts.map(|address| AccountMeta::new(address, false)));
        accounts.extend([
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ZK, false),
            AccountMeta::new_readonly(MEMO_PROGRAM_ID, false),
        ]);
        accounts.extend_from_slice(&self.extras);
        Payment {
            instruction: Instruction {
                program_id: FIXTURE,
                accounts,
                data,
            },
            contexts,
        }
    }

    pub fn pay(
        &mut self,
        payment: &Payment,
    ) -> Result<TransactionMetadata, Box<FailedTransactionMetadata>> {
        send_v1(
            &mut self.context,
            std::slice::from_ref(&payment.instruction),
            &[&self.proof_authority],
        )
    }
}

pub struct Payment {
    pub instruction: Instruction,
    pub contexts: [Pubkey; 6],
}
