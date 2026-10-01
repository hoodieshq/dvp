use crate::{
    processor::shared::confidential::{
        check_confidential_escrow, check_refund_contexts, LegBRefund,
    },
    require, require_len,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

const FIXED_ACCOUNTS_LEN: usize = 13;

/// Processes the RecoverConfidentialDvp instruction.
///
/// Confidential leg B counterpart of
/// [`process_recover_dvp`](super::recover_dvp::process_recover_dvp): after the
/// swap closes, `user_b` recovers leg B funds left by a partial refund, a pending
/// credit or a public deposit. Pending credits must first be applied with
/// [`process_apply_confidential_dvp`](super::apply_confidential_dvp::process_apply_confidential_dvp).
/// The leg B escrow closes only when all public and confidential balances are
/// empty. Leg A of a closed confidential swap uses public Recover instead.
///
/// # Account Layout
/// Accounts 0-7 follow the public Recover layout, selecting `user_b`, `mint_b`
/// and the Token-2022 leg B escrow. Account 8 is the ZK ElGamal Proof program;
/// accounts 9-12 are writable equality, validity, range and zero contexts,
/// or DvP program-id placeholders according to the refund mode.
/// Transfer-hook extras follow. Closed-account and context rent goes to `user_b`.
///
/// # Instruction Data
/// The five seed addresses and nonce from public Recover, followed by
/// [`LegBRefund`]. Refund modes and context requirements follow
/// [`process_reclaim_confidential_dvp`](super::reclaim_confidential_dvp::process_reclaim_confidential_dvp).
///
/// # Implementation Status
/// Currently decodes the arguments, checks the account count, optional-context
/// layout and escrow extension, then returns `InvalidInstructionData` without
/// CPIs or state changes. PDA, tombstone, authorization and proof checks are
/// not implemented yet.
pub fn process_recover_confidential_dvp(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let args = parse_instruction_data(instruction_data)?;

    require!(
        accounts.len() >= FIXED_ACCOUNTS_LEN,
        ProgramError::NotEnoughAccountKeys
    );
    let [_signer_info, _swap_dvp_info, _nonce_tombstone_info, _mint_info, dvp_escrow_ata_info, _signer_dest_ata_info, _token_program_info, _memo_program_info, _zk_elgamal_proof_program_info, equality_context_info, validity_context_info, range_context_info, zero_context_info] =
        &accounts[..FIXED_ACCOUNTS_LEN]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    check_confidential_escrow(dvp_escrow_ata_info)?;
    check_refund_contexts(
        program_id,
        &args.leg_b_refund,
        equality_context_info,
        validity_context_info,
        range_context_info,
        zero_context_info,
    )?;

    // Reject before any mutation or CPI until this lifecycle operation is implemented.
    Err(ProgramError::InvalidInstructionData)
}

// These arguments are consumed by the lifecycle implementation in a later stage.
#[allow(dead_code)]
#[derive(Debug, PartialEq)]
struct RecoverConfidentialDvpArgs {
    settlement_authority: Address,
    user_a: Address,
    user_b: Address,
    mint_a: Address,
    mint_b: Address,
    nonce: u64,
    leg_b_refund: LegBRefund,
}

fn parse_instruction_data(data: &[u8]) -> Result<RecoverConfidentialDvpArgs, ProgramError> {
    require_len!(data, 32 + 32 + 32 + 32 + 32 + 8);
    let mut offset = 0;

    let settlement_authority = Address::new_from_array(
        data[offset..offset + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 32;
    let user_a = Address::new_from_array(
        data[offset..offset + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 32;
    let user_b = Address::new_from_array(
        data[offset..offset + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 32;
    let mint_a = Address::new_from_array(
        data[offset..offset + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 32;
    let mint_b = Address::new_from_array(
        data[offset..offset + 32]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 32;
    let nonce = u64::from_le_bytes(
        data[offset..offset + 8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 8;
    let leg_b_refund = LegBRefund::try_from(&data[offset..])?;
    Ok(RecoverConfidentialDvpArgs {
        settlement_authority,
        user_a,
        user_b,
        mint_a,
        mint_b,
        nonce,
        leg_b_refund,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_instruction_data_decodes_fields() {
        let prefix: &[&[u8]] = &[
            &[1; 32],                                // settlement_authority
            &[2; 32],                                // user_a
            &[3; 32],                                // user_b
            &[10; 32],                               // mint_a
            &[20; 32],                               // mint_b
            &0x0102_0304_0506_0708u64.to_le_bytes(), // nonce
        ];
        let transfer_bytes = [
            &[6; 36][..], // new_source_decryptable_available_balance
            &[4; 64],     // auditor_ciphertext_lo
            &[5; 64],     // auditor_ciphertext_hi
        ]
        .concat();
        let transfer = crate::processor::shared::confidential::CtTransferData {
            new_source_decryptable_available_balance: [6; 36],
            auditor_ciphertext_lo: [4; 64],
            auditor_ciphertext_hi: [5; 64],
        };
        for (tag, leg_b_refund) in [
            (0, LegBRefund::None),
            (1, LegBRefund::Full(transfer.clone())),
            (2, LegBRefund::Partial(transfer)),
        ] {
            let mut data = prefix.concat();
            data.push(tag);
            if tag != 0 {
                data.extend_from_slice(&transfer_bytes);
            }
            assert_eq!(
                parse_instruction_data(&data).unwrap(),
                RecoverConfidentialDvpArgs {
                    settlement_authority: Address::new_from_array([1; 32]),
                    user_a: Address::new_from_array([2; 32]),
                    user_b: Address::new_from_array([3; 32]),
                    mint_a: Address::new_from_array([10; 32]),
                    mint_b: Address::new_from_array([20; 32]),
                    nonce: 0x0102_0304_0506_0708,
                    leg_b_refund
                }
            );
        }
    }
}
