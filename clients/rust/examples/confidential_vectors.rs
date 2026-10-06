//! Reproduce the shared Rust/TypeScript fixtures. These are public test keys.
use dvp_swap_program_client::confidential::{derive_shared_seed, EscrowKeys, MAX_TRANSFER_AMOUNT};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use solana_pubkey::Pubkey;

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let master = [0x42; 32];
    let [authority, user_a, user_b, mint_a, mint_b] =
        [1, 2, 3, 4, 5].map(|b| Pubkey::new_from_array([b; 32]));
    let swap = dvp_swap_program_client::verify::find_swap_dvp_address(
        &authority, &user_a, &user_b, &mint_a, &mint_b, 42,
    )
    .0;
    let seed = derive_shared_seed(&swap, |message| -> Result<[u8; 32], ()> {
        let mut mac = Hmac::<Sha256>::new_from_slice(&master).unwrap();
        mac.update(message);
        Ok(mac.finalize().into_bytes().into())
    })
    .unwrap();
    let keys = EscrowKeys::from_seed(&seed).unwrap();
    let secret: [u8; 32] = keys.elgamal.secret().into();
    let ae: [u8; 16] = (&keys.ae).into();
    let amounts: Vec<_> = [1, 65_535, 65_536, MAX_TRANSFER_AMOUNT].into_iter().map(|amount| {
        let encrypted = keys.encrypt_amount(amount).unwrap();
        serde_json::json!({ "amount": amount.to_string(), "ciphertext_lo": hex(&encrypted.lo), "ciphertext_hi": hex(&encrypted.hi) })
    }).collect();
    println!("{}", serde_json::to_string_pretty(&serde_json::json!({
        "master_key": hex(&master), "swap_pda": swap.to_string(), "shared_seed": hex(&seed),
        "elgamal_public_key": hex(&keys.elgamal.pubkey().to_bytes()),
        "elgamal_secret_key": hex(&secret), "ae_key": hex(&ae),
        "opening_lo": hex(&keys.opening_lo.to_bytes()), "opening_hi": hex(&keys.opening_hi.to_bytes()),
        "amounts": amounts
    })).unwrap());
}
