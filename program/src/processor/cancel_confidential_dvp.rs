use crate::{
    processor::shared::confidential::{check_confidential_swap, check_refund_contexts, LegBRefund},
    require, require_len,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

const FIXED_ACCOUNTS_LEN: usize = 16;

/// Processes the CancelConfidentialDvp instruction.
///
/// Confidential counterpart of [`process_cancel_dvp`](super::cancel_dvp::process_cancel_dvp):
/// the settlement authority unwinds both legs, including after expiry.
/// The swap and asset escrow close; the leg B escrow stays open if any balance
/// remains. After a partial leg B refund, `user_b` recovers the remainder with
/// [`process_recover_confidential_dvp`](super::recover_confidential_dvp::process_recover_confidential_dvp).
/// Pending credits are not applied by this instruction.
///
/// # Account Layout
/// Accounts 0-10 follow the public Cancel layout, with Token-2022 for leg B.
/// Account 11 is the ZK ElGamal Proof program; accounts 12-15 are writable
/// equality, validity, range and zero proof contexts, or DvP program-id
/// placeholders according to the refund mode. Context rent goes to the signer.
/// Transfer-hook extras follow, split by `leg_a_extras_count` as in public Cancel.
///
/// # Instruction Data
/// `leg_a_extras_count` (u8), then [`LegBRefund`]. Refund modes and their
/// required contexts follow
/// [`process_reclaim_confidential_dvp`](super::reclaim_confidential_dvp::process_reclaim_confidential_dvp).
/// Here `None` skips the leg B transfer; any public leg B balance remains for Recover.
///
/// # Implementation Status
/// Currently decodes the arguments, checks the account count, optional-context
/// layout and swap mode, then returns `InvalidInstructionData` without CPIs
/// or state changes. Authorization and proof validation are not implemented yet.
pub fn process_cancel_confidential_dvp(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let args = parse_instruction_data(instruction_data)?;

    require!(
        accounts.len() >= FIXED_ACCOUNTS_LEN,
        ProgramError::NotEnoughAccountKeys
    );
    let [_settlement_authority_info, swap_dvp_info, _mint_a_info, _mint_b_info, _dvp_ata_a_info, _dvp_ata_b_info, _user_a_ata_a_info, _user_b_ata_b_info, _token_program_a_info, _token_program_b_info, _memo_program_info, _zk_elgamal_proof_program_info, equality_context_info, validity_context_info, range_context_info, zero_context_info] =
        &accounts[..FIXED_ACCOUNTS_LEN]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    check_confidential_swap(program_id, swap_dvp_info)?;
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
struct CancelConfidentialDvpArgs {
    leg_a_extras_count: u8,
    leg_b_refund: LegBRefund,
}

fn parse_instruction_data(data: &[u8]) -> Result<CancelConfidentialDvpArgs, ProgramError> {
    require_len!(data, 1);
    let mut offset = 0;

    let leg_a_extras_count = data[offset];
    offset += 1;
    let leg_b_refund = LegBRefund::try_from(&data[offset..])?;
    Ok(CancelConfidentialDvpArgs {
        leg_a_extras_count,
        leg_b_refund,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_instruction_data_decodes_fields() {
        let prefix: &[&[u8]] = &[
            &[3], // leg_a_extras_count
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
                CancelConfidentialDvpArgs {
                    leg_a_extras_count: 3,
                    leg_b_refund
                }
            );
        }
    }
}
