use crate::{
    error::DvpSwapProgramError, require, require_len, state::swap_dvp::MAX_REF_STRING_LEN,
};
use pinocchio::{account::AccountView, error::ProgramError, Address, ProgramResult};

const FIXED_ACCOUNTS_LEN: usize = 15;

/// Processes the CreateConfidentialDvp instruction.
///
/// Confidential counterpart of [`process_create_dvp`](super::create_dvp::process_create_dvp):
/// creates a swap with a public leg A and an encrypted leg B amount, and
/// configures the Token-2022 leg B escrow for confidential transfers.
///
/// # Account Layout
/// Accounts 0-13 follow the public Create layout. `mint_b` must support
/// confidential transfers and `token_program_b` must be Token-2022.
/// Account 14 is the read-only instructions sysvar, used to locate the inline
/// PubkeyValidity proof for the escrow's ElGamal key.
///
/// # Instruction Data
/// `amount_a`, `expiry_timestamp` and `nonce` are followed by the low and high
/// ciphertexts of the agreed leg B amount, `decryptable_zero_balance` and a
/// non-zero relative `pubkey_validity_proof_offset`. There is no public
/// `amount_b`. The reference string, settlement destinations and earliest
/// settlement timestamp use the same optional encoding as public Create.
///
/// # Implementation Status
/// Currently decodes the arguments and checks the account count, then returns
/// `InvalidInstructionData` without creating accounts or invoking Token-2022.
pub fn process_create_confidential_dvp(
    _program_id: &Address,
    accounts: &[AccountView],
    instruction_data: &[u8],
) -> ProgramResult {
    let _args = parse_instruction_data(instruction_data)?;

    require!(
        accounts.len() >= FIXED_ACCOUNTS_LEN,
        ProgramError::NotEnoughAccountKeys
    );
    let [_payer_info, _swap_dvp_info, _nonce_tombstone_info, _settlement_authority_info, _user_a_info, _user_b_info, _mint_a_info, _mint_b_info, _dvp_ata_a_info, _dvp_ata_b_info, _system_program_info, _token_program_a_info, _token_program_b_info, _associated_token_program_info, _instructions_sysvar_info] =
        &accounts[..FIXED_ACCOUNTS_LEN]
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    // Reject before any mutation or CPI until this lifecycle operation is implemented.
    Err(ProgramError::InvalidInstructionData)
}

// These arguments are consumed by the lifecycle implementation in a later stage.
#[allow(dead_code)]
#[derive(Debug, PartialEq)]
struct CreateConfidentialDvpArgs {
    amount_a: u64,
    expiry_timestamp: i64,
    nonce: u64,
    amount_b_ciphertext_lo: [u8; 64],
    amount_b_ciphertext_hi: [u8; 64],
    decryptable_zero_balance: [u8; 36],
    pubkey_validity_proof_offset: i8,
    ref_string: [u8; MAX_REF_STRING_LEN],
    user_a_settlement_destination: Option<Address>,
    user_b_settlement_destination: Option<Address>,
    earliest_settlement_timestamp: Option<i64>,
}

fn parse_instruction_data(data: &[u8]) -> Result<CreateConfidentialDvpArgs, ProgramError> {
    require_len!(data, 8 + 8 + 8 + 64 + 64 + 36 + 1 + 4);
    let mut offset = 0;

    let amount_a = u64::from_le_bytes(
        data[offset..offset + 8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 8;
    let expiry_timestamp = i64::from_le_bytes(
        data[offset..offset + 8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 8;
    let nonce = u64::from_le_bytes(
        data[offset..offset + 8]
            .try_into()
            .map_err(|_| ProgramError::InvalidInstructionData)?,
    );
    offset += 8;
    let amount_b_ciphertext_lo: [u8; 64] = data[offset..offset + 64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    offset += 64;
    let amount_b_ciphertext_hi: [u8; 64] = data[offset..offset + 64]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    offset += 64;
    let decryptable_zero_balance: [u8; 36] = data[offset..offset + 36]
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    offset += 36;
    let pubkey_validity_proof_offset = data[offset] as i8;
    offset += 1;
    require!(
        pubkey_validity_proof_offset != 0,
        ProgramError::InvalidInstructionData
    );

    let ref_string = match data[offset] {
        0 => {
            offset += 1;
            [0u8; MAX_REF_STRING_LEN]
        }
        1 => {
            // Tag + u32 length prefix + the three remaining option tags.
            require_len!(data, offset + 1 + 4 + 3);
            let ref_string_wire_len = u32::from_le_bytes(
                data[offset + 1..offset + 5]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            ) as usize;
            require!(
                ref_string_wire_len <= MAX_REF_STRING_LEN,
                DvpSwapProgramError::RefStringTooLong
            );
            // The string bytes plus the three remaining option tags.
            require_len!(data, offset + 5 + ref_string_wire_len + 3);
            let mut ref_string = [0u8; MAX_REF_STRING_LEN];
            ref_string[..ref_string_wire_len]
                .copy_from_slice(&data[offset + 5..offset + 5 + ref_string_wire_len]);
            offset += 5 + ref_string_wire_len;
            ref_string
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    let user_a_settlement_destination = match data[offset] {
        0 => {
            offset += 1;
            None
        }
        1 => {
            // Tag + pubkey payload + the two remaining option tags.
            require_len!(data, offset + 1 + 32 + 2);
            let mut destination = [0u8; 32];
            destination.copy_from_slice(&data[offset + 1..offset + 33]);
            offset += 33;
            Some(Address::new_from_array(destination))
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    let user_b_settlement_destination = match data[offset] {
        0 => {
            offset += 1;
            None
        }
        1 => {
            // Tag + pubkey payload + the remaining option tag.
            require_len!(data, offset + 1 + 32 + 1);
            let mut destination = [0u8; 32];
            destination.copy_from_slice(&data[offset + 1..offset + 33]);
            offset += 33;
            Some(Address::new_from_array(destination))
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    let earliest_settlement_timestamp = match data[offset] {
        0 => {
            offset += 1;
            None
        }
        1 => {
            require_len!(data, offset + 1 + 8);
            let value = i64::from_le_bytes(
                data[offset + 1..offset + 9]
                    .try_into()
                    .map_err(|_| ProgramError::InvalidInstructionData)?,
            );
            offset += 1 + 8;
            Some(value)
        }
        _ => return Err(ProgramError::InvalidInstructionData),
    };

    require!(data.len() == offset, ProgramError::InvalidInstructionData);
    Ok(CreateConfidentialDvpArgs {
        amount_a,
        expiry_timestamp,
        nonce,
        amount_b_ciphertext_lo,
        amount_b_ciphertext_hi,
        decryptable_zero_balance,
        pubkey_validity_proof_offset,
        ref_string,
        user_a_settlement_destination,
        user_b_settlement_destination,
        earliest_settlement_timestamp,
    })
}

#[cfg(test)]
mod tests {
    extern crate alloc;
    use super::*;

    const PROOF_OFFSET: usize = 8 * 3 + 64 * 2 + 36;
    const OPTIONS_OFFSET: usize = PROOF_OFFSET + 1;

    #[test]
    fn create_options_and_proof_offset_are_strict() {
        let mut data = alloc::vec![0; OPTIONS_OFFSET + 4];
        data[PROOF_OFFSET] = 255; // signed offset -1
        assert_eq!(
            process_create_confidential_dvp(&crate::ID, &[], &data),
            Err(ProgramError::NotEnoughAccountKeys)
        );
        for len in 0..data.len() {
            assert_eq!(
                process_create_confidential_dvp(&crate::ID, &[], &data[..len]),
                Err(ProgramError::InvalidInstructionData)
            );
        }
        for offset in OPTIONS_OFFSET..OPTIONS_OFFSET + 4 {
            data[offset] = 2;
            assert_eq!(
                process_create_confidential_dvp(&crate::ID, &[], &data),
                Err(ProgramError::InvalidInstructionData)
            );
            data[offset] = 0;
        }
        data[PROOF_OFFSET] = 0;
        assert_eq!(
            process_create_confidential_dvp(&crate::ID, &[], &data),
            Err(ProgramError::InvalidInstructionData)
        );
    }

    #[test]
    fn create_present_options_and_string_bounds() {
        let mut prefix = alloc::vec![0; OPTIONS_OFFSET];
        prefix[PROOF_OFFSET] = 255;
        for len in [0u32, 64, 65] {
            let mut data = prefix.clone();
            data.push(1);
            data.extend_from_slice(&len.to_le_bytes());
            data.extend(core::iter::repeat_n(b'x', len as usize));
            for size in [32, 32, 8] {
                data.push(1);
                data.extend(core::iter::repeat_n(0, size));
            }
            if len <= 64 {
                assert_eq!(
                    process_create_confidential_dvp(&crate::ID, &[], &data),
                    Err(ProgramError::NotEnoughAccountKeys)
                );
                for truncated in 0..data.len() {
                    assert_eq!(
                        process_create_confidential_dvp(&crate::ID, &[], &data[..truncated]),
                        Err(ProgramError::InvalidInstructionData)
                    );
                }
            } else {
                assert_eq!(
                    process_create_confidential_dvp(&crate::ID, &[], &data),
                    Err(DvpSwapProgramError::RefStringTooLong.into())
                );
            }
        }
    }

    #[test]
    fn ref_string_preserves_non_utf8_bytes_like_public_create() {
        let mut data = alloc::vec![0; OPTIONS_OFFSET];
        data[PROOF_OFFSET] = 255;
        data.push(1); // ref_string is present
        data.extend_from_slice(&1u32.to_le_bytes());
        data.push(0xff); // opaque reference byte, not valid UTF-8
        data.extend_from_slice(&[0; 3]); // remaining options absent
        let mut expected = [0; MAX_REF_STRING_LEN];
        expected[0] = 0xff;
        assert_eq!(parse_instruction_data(&data).unwrap().ref_string, expected);
    }

    #[test]
    fn parse_instruction_data_decodes_fields() {
        let prefix = [
            &1_000u64.to_le_bytes()[..],             // amount_a
            &(-1_780_000_000i64).to_le_bytes(),      // expiry_timestamp
            &0x0102_0304_0506_0708u64.to_le_bytes(), // nonce
            &[4; 64],                                // amount_b_ciphertext_lo
            &[5; 64],                                // amount_b_ciphertext_hi
            &[6; 36],                                // decryptable_zero_balance
            &(-1i8).to_le_bytes(),                   // pubkey_validity_proof_offset
        ]
        .concat();
        for options_present in [false, true] {
            let mut data = prefix.clone();
            let mut ref_string = [0; MAX_REF_STRING_LEN];
            if options_present {
                ref_string[..5].copy_from_slice(b"trade");
                data.extend_from_slice(
                    &[
                        &[1][..],
                        &5u32.to_le_bytes(),
                        b"trade", // ref_string
                        &[1],
                        &[7; 32], // user_a_settlement_destination
                        &[1],
                        &[8; 32], // user_b_settlement_destination
                        &[1],
                        &(-1_780_003_600i64).to_le_bytes(), // earliest_settlement_timestamp
                    ]
                    .concat(),
                );
            } else {
                data.extend_from_slice(&[0; 4]); // all options absent
            }
            assert_eq!(
                parse_instruction_data(&data).unwrap(),
                CreateConfidentialDvpArgs {
                    amount_a: 1_000,
                    expiry_timestamp: -1_780_000_000,
                    nonce: 0x0102_0304_0506_0708,
                    amount_b_ciphertext_lo: [4; 64],
                    amount_b_ciphertext_hi: [5; 64],
                    decryptable_zero_balance: [6; 36],
                    pubkey_validity_proof_offset: -1,
                    ref_string,
                    user_a_settlement_destination: options_present
                        .then(|| Address::new_from_array([7; 32])),
                    user_b_settlement_destination: options_present
                        .then(|| Address::new_from_array([8; 32])),
                    earliest_settlement_timestamp: options_present.then_some(-1_780_003_600),
                }
            );
            data.push(0);
            assert_eq!(
                parse_instruction_data(&data),
                Err(ProgramError::InvalidInstructionData)
            );
        }
    }
}
