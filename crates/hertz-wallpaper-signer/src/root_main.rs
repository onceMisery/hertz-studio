// SPDX-License-Identifier: MIT
//! An explicitly invoked offline executable. The online service has no root
//! seed setting and cannot call this executable through its IPC protocol.
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    path::Path,
};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use hertz_wallpaper::release::authorization::{
    AuthorizationChain, KeyAuthorization, PublicKey, RootPin, SignedKeyAuthorization,
    MAX_AUTHORIZATION_BYTES,
};
use hertz_wallpaper_signer::{
    config::absolute,
    platform,
    protocol::{self, Error, Result},
};
use zeroize::Zeroizing;

fn main() {
    platform::restrict_process_files();
    if let Err(error) = run() {
        eprintln!("hertz-wallpaper-root: {}", error.0);
        std::process::exit(1);
    }
}

fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [command, seed_path, pin_path, draft_path, previous_path, output_path] = args.as_slice()
    else {
        println!("hertz-wallpaper-root authorize <absolute-root-seed> <root-pin.json> <authorization.json> <previous-chain.json|genesis> <absolute-new-chain.json>");
        return if args.is_empty() || args == ["--help"] {
            Ok(())
        } else {
            Err(Error("invalid_command_arguments"))
        };
    };
    if command != "authorize" || !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(Error("offline_authorization_requires_terminal"));
    }
    for path in [seed_path, pin_path, draft_path, output_path] {
        absolute(Path::new(path))?;
    }
    if previous_path != "genesis" {
        absolute(Path::new(previous_path))?;
    }
    let identity = platform::current_identity()?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct PinFile {
        hub_id: String,
        root: PublicKey,
        root_fingerprint: String,
    }
    let pin_file: PinFile = protocol::parse(&protocol::read_file(Path::new(pin_path), 16 * 1024)?)?;
    let pin = RootPin::confirm(pin_file.hub_id, pin_file.root, &pin_file.root_fingerprint)
        .map_err(|_| Error("root_pin_invalid"))?;
    let draft = KeyAuthorization::parse(&protocol::read_file(
        Path::new(draft_path),
        MAX_AUTHORIZATION_BYTES,
    )?)
    .map_err(|_| Error("authorization_draft_invalid"))?;
    let (mut chain, signing_root) = if previous_path == "genesis" {
        if draft.generation != 1
            || draft.hub_id != pin.hub_id()
            || draft.root_key_id != pin.root().key_id
        {
            return Err(Error("genesis_authorization_mismatch"));
        }
        (
            AuthorizationChain {
                bootstrap_root: pin.root().clone(),
                authorizations: Vec::new(),
            },
            pin.root().clone(),
        )
    } else {
        let verified = AuthorizationChain::parse(&protocol::read_file(
            Path::new(previous_path),
            MAX_AUTHORIZATION_BYTES,
        )?)
        .and_then(|chain| chain.verify(&pin, None))
        .map_err(|_| Error("previous_authorization_chain_invalid"))?;
        verified
            .check_extension(&draft)
            .map_err(|_| Error("authorization_does_not_extend_tail"))?;
        (verified.chain().clone(), verified.current_root().clone())
    };
    let mut file = platform::private_file(Path::new(seed_path), &identity, false)?;
    if file.metadata()?.len() != 32 {
        return Err(Error("root_seed_must_be_32_bytes"));
    }
    let mut seed = Zeroizing::new([0u8; 32]);
    file.read_exact(&mut *seed)?;
    let key = SigningKey::from_bytes(&seed);
    if key.verifying_key().as_bytes()
        != &signing_root
            .bytes()
            .map_err(|_| Error("root_key_invalid"))?
    {
        return Err(Error("offline_root_seed_does_not_match_chain"));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(&draft).map_err(|_| Error("authorization_encoding_failed"))?
    );
    println!("Pinned bootstrap root SHA-256: {}", pin.fingerprint());
    println!(
        "Current signing root SHA-256: {}",
        signing_root
            .fingerprint()
            .map_err(|_| Error("root_key_invalid"))?
    );
    let digest = draft
        .canonical_digest()
        .map_err(|_| Error("authorization_encoding_failed"))?;
    println!("Authorization body SHA-256: {digest}");
    print!("Authorize this exact generation by typing the full body SHA-256 (Enter cancels): ");
    io::stdout().flush()?;
    let mut answer = String::new();
    io::stdin().lock().take(130).read_line(&mut answer)?;
    if answer.trim() != digest {
        return Err(Error("offline_authorization_cancelled"));
    }
    let signature = URL_SAFE_NO_PAD.encode(
        key.sign(
            &draft
                .signing_bytes()
                .map_err(|_| Error("authorization_encoding_failed"))?,
        )
        .to_bytes(),
    );
    chain.authorizations.push(SignedKeyAuthorization {
        authorization: draft,
        signature,
    });
    let verified = chain
        .verify(&pin, None)
        .map_err(|_| Error("signed_authorization_chain_invalid"))?;
    let bytes = verified
        .canonical_bytes()
        .map_err(|_| Error("authorization_encoding_failed"))?;
    platform::new_private_bytes(Path::new(output_path), &identity, &bytes)?;
    println!(
        "Saved generation {} to the new chain file.",
        verified.watermark().generation
    );
    Ok(())
}
