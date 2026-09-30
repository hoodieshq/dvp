use crate::{
    processor::shared::confidential::{check_confidential_escrow, check_confidential_swap},
    require, require_len,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

const FIXED_ACCOUNTS_LEN: usize = 5;

/// Processes the ApplyConfidentialDvp instruction.
///
/// Moves the cash escrow's pending confidential balance into its available
/// balance through Token-2022 ApplyPendingBalance. Either depositor or the
/// settlement authority may apply while the swap is open or after it closes.
/// There is no public counterpart; the post-close PDA and tombstone checks
/// follow [`process_recover_dvp`](super::recover_dvp::process_recover_dvp).
///
/// # Account Layout
/// 0. `[signer]` signer - user_a, user_b or settlement_authority
/// 1. `[]` swap_dvp - Open confidential swap or its closed PDA address
/// 2. `[]` nonce_tombstone - Proves the swap existed after it closes
/// 3. `[writable]` dvp_ata_b - PDA's canonical Token-2022 cash escrow
/// 4. `[]` token_program - Token-2022 program
///
/// No proof contexts or transfer-hook extras are required.
///
/// # Instruction Data
/// `expected_pending_balance_credit_counter` (u64), the new decryptable
/// available balance (36 bytes), then the five seed addresses and nonce in
/// public Recover order. The counter and decryptable balance are forwarded
/// to Token-2022; the DvP program cannot verify the encrypted plaintext.
///
/// # Implementation Status
/// Currently decodes the arguments and checks the account count plus the open
/// swap's mode or closed path's escrow extension, then returns
/// `InvalidInstructionData` without CPIs or state changes. PDA, tombstone and
/// authorization checks are not implemented yet.
pub fn process_apply_confidential_dvp(
    program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let _args = parse_instruction_data(instruction_data)?;

    require!(
        accounts.len() >= FIXED_ACCOUNTS_LEN,
        ProgramError::NotEnoughAccountKeys
    );
    let [_signer_info, swap_dvp_info, _nonce_tombstone_info, dvp_ata_b_info, _token_program_info] =
        &accounts[..FIXED_ACCOUNTS_LEN]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    if swap_dvp_info.owned_by(program_id) {
        check_confidential_swap(program_id, swap_dvp_info)?;
    } else {
        check_confidential_escrow(dvp_ata_b_info)?;
    }

    // Reject before any mutation or CPI until this lifecycle operation is implemented.
    Err(ProgramError::InvalidInstructionData)
}

// These arguments are consumed by the lifecycle implementation in a later stage.
#[allow(dead_code)]
#[derive(Debug, PartialEq)]
struct ApplyConfidentialDvpArgs {
    expected_pending_balance_credit_counter: u64,
    new_decryptable_available_balance: [u8; 36],
    settlement_authority: Address,
    user_a: Address,
    user_b: Address,
    mint_a: Address,
    mint_b: Address,
    nonce: u64,
}

fn parse_instruction_data(data: &[u8]) -> Result<ApplyConfidentialDvpArgs, ProgramError> {
    require_len!(data, 8 + 36 + 32 + 32 + 32 + 32 + 32 + 8);
    let mut offset = 0;

    let expected_pending_balance_credit_counter = u64::from_le_bytes(
        data[offset..offset + 8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 8;
    let new_decryptable_available_balance: [u8; 36] = data[offset..offset + 36]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    offset += 36;
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
    require!(data.len() == offset, ProgramError::InvalidInstructionData);
    Ok(ApplyConfidentialDvpArgs {
        expected_pending_balance_credit_counter,
        new_decryptable_available_balance,
        settlement_authority,
        user_a,
        user_b,
        mint_a,
        mint_b,
        nonce,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_instruction_data_decodes_fields() {
        let data = [
            &257u64.to_le_bytes()[..], // expected_pending_balance_credit_counter
            &[6; 36],                  // new_decryptable_available_balance
            &[1; 32],                  // settlement_authority
            &[2; 32],                  // user_a
            &[3; 32],                  // user_b
            &[10; 32],                 // mint_a
            &[20; 32],                 // mint_b
            &0x0102_0304_0506_0708u64.to_le_bytes(), // nonce
        ]
        .concat();
        assert_eq!(
            parse_instruction_data(&data).unwrap(),
            ApplyConfidentialDvpArgs {
                expected_pending_balance_credit_counter: 257,
                new_decryptable_available_balance: [6; 36],
                settlement_authority: Address::new_from_array([1; 32]),
                user_a: Address::new_from_array([2; 32]),
                user_b: Address::new_from_array([3; 32]),
                mint_a: Address::new_from_array([10; 32]),
                mint_b: Address::new_from_array([20; 32]),
                nonce: 0x0102_0304_0506_0708,
            }
        );
    }
}
