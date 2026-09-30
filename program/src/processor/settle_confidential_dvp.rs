use crate::{
    processor::shared::confidential::{check_confidential_swap, check_transfer_contexts},
    processor::shared::confidential_types::CtTransferData,
    require, require_len,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

const FIXED_ACCOUNTS_LEN: usize = 23;

/// Processes the SettleConfidentialDvp instruction.
///
/// Confidential counterpart of [`process_settle_dvp`](super::settle_dvp::process_settle_dvp):
/// the settlement authority delivers both legs atomically and refunds surplus
/// to each depositor. Cash payment proofs bind the transferred amount to the
/// ciphertexts stored at Create. The swap and asset escrow close; the cash
/// escrow stays open if pending or public balances remain, for Apply and Recover.
/// Pending credits are not applied during settlement.
///
/// # Account Layout
/// Accounts 0-12 follow the public Settle layout, with Token-2022 for leg B.
/// Account 13 is the ZK ElGamal Proof program. Writable proof contexts follow:
/// 14-16 are payment equality, validity and range; 17-18 bind the low and high
/// payment limbs to the agreed amount; 19 proves the remaining available
/// balance is zero; 20-22 are surplus equality, validity and range.
/// The surplus contexts use DvP program-id placeholders when `surplus_b` is
/// absent. Transfer-hook extras follow the fixed prefix and are split by
/// `leg_a_extras_count`, as in public Settle.
///
/// # Instruction Data
/// `leg_a_extras_count` (u8), `payment` ([`CtTransferData`]) and `surplus_b`
/// (`Option<CtTransferData>`), in that order. Payment goes to the seller's
/// configured cash destination; any cash surplus goes to `user_b`'s own ATA.
///
/// # Implementation Status
/// Currently decodes the arguments, checks the account count, optional-context
/// layout and swap mode, then returns `InvalidInstructionData` without CPIs
/// or state changes. Authorization and proof validation are not implemented yet.
pub fn process_settle_confidential_dvp(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let args = parse_instruction_data(instruction_data)?;

    require!(
        accounts.len() >= FIXED_ACCOUNTS_LEN,
        ProgramError::NotEnoughAccountKeys
    );
    let [_settlement_authority_info, swap_dvp_info, _mint_a_info, _mint_b_info, _dvp_ata_a_info, _dvp_ata_b_info, _user_a_destination_ata_b_info, _user_b_destination_ata_a_info, _user_a_ata_a_info, _user_b_ata_b_info, _token_program_a_info, _token_program_b_info, _memo_program_info, _zk_elgamal_proof_program_info, _payment_equality_context_info, _payment_validity_context_info, _payment_range_context_info, _eq_lo_context_info, _eq_hi_context_info, _zero_context_info, surplus_equality_context_info, surplus_validity_context_info, surplus_range_context_info] =
        &accounts[..FIXED_ACCOUNTS_LEN]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    check_transfer_contexts(
        program_id,
        args.surplus.is_some(),
        surplus_equality_context_info,
        surplus_validity_context_info,
        surplus_range_context_info,
    )?;
    check_confidential_swap(program_id, swap_dvp_info)?;

    // Reject before any mutation or CPI until this lifecycle operation is implemented.
    Err(ProgramError::InvalidInstructionData)
}

// These arguments are consumed by the lifecycle implementation in a later stage.
#[allow(dead_code)]
#[derive(Debug, PartialEq)]
struct SettleConfidentialDvpArgs {
    leg_a_extras_count: u8,
    payment: CtTransferData,
    surplus: Option<CtTransferData>,
}

fn parse_instruction_data(data: &[u8]) -> Result<SettleConfidentialDvpArgs, ProgramError> {
    require_len!(data, 1);
    let mut offset = 0;

    let leg_a_extras_count = data[offset];
    offset += 1;
    require_len!(data, offset + CtTransferData::LEN + 1);
    let payment = CtTransferData::try_from(&data[offset..offset + CtTransferData::LEN])?;
    offset += CtTransferData::LEN;
    let surplus = match data[offset] {
        0 if data.len() == offset + 1 => None,
        1 => Some(CtTransferData::try_from(&data[offset + 1..])?),
        _ => return Err(ProgramError::InvalidInstructionData),
    };
    Ok(SettleConfidentialDvpArgs {
        leg_a_extras_count,
        payment,
        surplus,
    })
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;

    #[test]
    fn settle_surplus_option_is_strict() {
        for tag in 0..=1 {
            let mut data = alloc::vec![0; 1 + CtTransferData::LEN + 1 + usize::from(tag) * CtTransferData::LEN];
            data[1 + CtTransferData::LEN] = tag;
            assert_eq!(
                process_settle_confidential_dvp(&crate::ID, &[], &data),
                Err(ProgramError::NotEnoughAccountKeys)
            );
            for len in 0..data.len() {
                assert_eq!(
                    process_settle_confidential_dvp(&crate::ID, &[], &data[..len]),
                    Err(ProgramError::InvalidInstructionData)
                );
            }
            data.push(0);
            assert_eq!(
                process_settle_confidential_dvp(&crate::ID, &[], &data),
                Err(ProgramError::InvalidInstructionData)
            );
        }
        let mut data = [0; 1 + CtTransferData::LEN + 1];
        data[1 + CtTransferData::LEN] = 2;
        assert_eq!(
            process_settle_confidential_dvp(&crate::ID, &[], &data),
            Err(ProgramError::InvalidInstructionData)
        );
    }

    #[test]
    fn parse_instruction_data_decodes_fields() {
        let payment = CtTransferData {
            new_source_decryptable_available_balance: [6; 36],
            auditor_ciphertext_lo: [4; 64],
            auditor_ciphertext_hi: [5; 64],
        };
        let surplus = CtTransferData {
            new_source_decryptable_available_balance: [9; 36],
            auditor_ciphertext_lo: [7; 64],
            auditor_ciphertext_hi: [8; 64],
        };
        for surplus_present in [false, true] {
            let mut data = [
                &[3][..],     // leg_a_extras_count
                &[6; 36][..], // new_source_decryptable_available_balance
                &[4; 64],     // auditor_ciphertext_lo
                &[5; 64],     // auditor_ciphertext_hi
            ]
            .concat();
            data.push(u8::from(surplus_present));
            if surplus_present {
                data.extend_from_slice(
                    &[
                        &[9; 36][..], // surplus decryptable balance
                        &[7; 64],     // surplus auditor_ciphertext_lo
                        &[8; 64],     // surplus auditor_ciphertext_hi
                    ]
                    .concat(),
                );
            }
            assert_eq!(
                parse_instruction_data(&data).unwrap(),
                SettleConfidentialDvpArgs {
                    leg_a_extras_count: 3,
                    payment: payment.clone(),
                    surplus: surplus_present.then(|| surplus.clone()),
                }
            );
        }
    }
}
