use crate::{
    processor::shared::confidential::{check_confidential_swap, check_refund_contexts, LegBRefund},
    require,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

const FIXED_ACCOUNTS_LEN: usize = 12;

/// Processes the ReclaimConfidentialDvp instruction.
///
/// Confidential counterpart of [`process_reclaim_dvp`](super::reclaim_dvp::process_reclaim_dvp):
/// a depositor takes back its own leg while the swap and escrows stay open.
/// Leg A uses the public transfer path. Leg B supports full or partial
/// confidential refunds to `user_b`, or withdrawal of its public balance.
///
/// # Account Layout
/// Accounts 0-6 follow the public Reclaim layout, except the signer must also
/// be writable to receive closed proof-context rent. Account 7 is the ZK
/// ElGamal Proof program; accounts 8-11 are the equality, validity, range and
/// zero proof contexts. Present contexts are writable; absent contexts use
/// the DvP program id as a placeholder. Transfer-hook extras follow this prefix.
///
/// # Instruction Data
/// [`LegBRefund`] selects the leg B refund: `None` has no transfer payload or
/// contexts; `Full` carries transfer data and all four contexts; `Partial`
/// carries transfer data and the first three contexts, leaving a remainder.
/// `user_a` supplies `None`. For `user_b`, `None` withdraws the public balance
/// only when the confidential available balance has been reset.
///
/// # Implementation Status
/// Currently decodes the arguments, checks the account count, optional-context
/// layout and swap mode, then returns `InvalidInstructionData` without CPIs
/// or state changes. Authorization and proof validation are not implemented yet.
pub fn process_reclaim_confidential_dvp(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let args = parse_instruction_data(instruction_data)?;

    require!(
        accounts.len() >= FIXED_ACCOUNTS_LEN,
        ProgramError::NotEnoughAccountKeys
    );
    let [_signer_info, swap_dvp_info, _mint_info, _dvp_source_ata_info, _signer_dest_ata_info, _token_program_info, _memo_program_info, _zk_elgamal_proof_program_info, equality_context_info, validity_context_info, range_context_info, zero_context_info] =
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

#[derive(Debug, PartialEq)]
struct ReclaimConfidentialDvpArgs {
    leg_b_refund: LegBRefund,
}

fn parse_instruction_data(data: &[u8]) -> Result<ReclaimConfidentialDvpArgs, ProgramError> {
    let leg_b_refund = LegBRefund::try_from(data)?;
    Ok(ReclaimConfidentialDvpArgs { leg_b_refund })
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;

    #[test]
    fn parse_instruction_data_decodes_fields() {
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
            let mut data = alloc::vec![tag];
            if tag != 0 {
                data.extend_from_slice(&transfer_bytes);
            }
            assert_eq!(
                parse_instruction_data(&data).unwrap(),
                ReclaimConfidentialDvpArgs { leg_b_refund }
            );
        }
    }
}
