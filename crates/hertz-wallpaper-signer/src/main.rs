// SPDX-License-Identifier: MIT
use hertz_wallpaper_signer::{config, ledger, platform, protocol, server};

use config::Config;
use protocol::{Approval, Request, Response, Result};
use std::{
    io::{self, BufRead, IsTerminal, Read, Write},
    path::Path,
};

#[tokio::main]
async fn main() {
    platform::restrict_process_files();
    if let Err(error) = run().await {
        eprintln!("hertz-wallpaper-signer: {}", error.0);
        if error.0 == "operation_outcome_unknown" {
            eprintln!(
                "Use query with the same operation UUID and body SHA-256 to recover its outcome."
            );
        }
        std::process::exit(1);
    }
}
async fn run() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [command, flag, path]
            if matches!(command.as_str(), "initialize" | "serve") && flag == "--config" =>
        {
            let config = Config::load(Path::new(path))?;
            if command == "initialize" {
                ledger::Ledger::initialize(&config).await?;
                print_response(Response::state("initialized"))
            } else {
                server::serve(config, None).await
            }
        }
        [command, flag, path, proof_flag, proof]
            if command == "serve" && flag == "--config" && proof_flag == "--recovery-proof" =>
        {
            server::serve(Config::load(Path::new(path))?, Some(Path::new(proof))).await
        }
        [command, flag, path] if command == "checkpoint" && flag == "--config" => {
            let ledger = ledger::Ledger::open(Config::load(Path::new(path))?, None).await?;
            println!(
                "{}",
                serde_json::to_string_pretty(&ledger.tail())
                    .map_err(|_| protocol::Error("checkpoint_encoding_failed"))?
            );
            ledger.close().await;
            Ok(())
        }
        [command, endpoint, expected_service, file] if command == "approve" => {
            require_terminal()?;
            let approval: Approval =
                protocol::parse(&protocol::read_file(Path::new(file), protocol::MAX_FRAME)?)?;
            approval.validate()?;
            let digest = approval.document.digest()?;
            // Escaped JSON cannot inject terminal control sequences. The
            // complete immutable body is displayed, including every revocation.
            println!(
                "{}",
                serde_json::to_string_pretty(&approval)
                    .map_err(|_| protocol::Error("invalid_approval"))?
            );
            println!("Canonical body SHA-256: {digest}");
            confirm(&digest, "Approve this exact document and review evidence")?;
            print_response(
                server::call(
                    endpoint,
                    expected_service,
                    Request::Approve {
                        approval: Box::new(approval),
                        confirmed_digest: digest,
                    },
                )
                .await?,
            )
        }
        [command, endpoint, expected_service, operation, digest] if command == "revoke" => {
            require_terminal()?;
            protocol::body_identity(operation, digest)?;
            let response = server::call(
                endpoint,
                expected_service,
                Request::Query {
                    operation_id: operation.clone(),
                    body_digest: digest.clone(),
                },
            )
            .await?;
            if response.state != "approved" {
                return print_response(response).and(Err(protocol::Error(
                    "only_unsigned_approval_can_be_revoked",
                )));
            }
            if response.approver_identity.as_deref() != Some(platform::current_identity()?.as_str())
            {
                return Err(protocol::Error("approval_owner_required"));
            }
            let approval = response
                .approval
                .ok_or(protocol::Error("protected_approval_missing"))?;
            println!(
                "{}",
                serde_json::to_string_pretty(&approval)
                    .map_err(|_| protocol::Error("invalid_approval"))?
            );
            println!("Canonical body SHA-256: {digest}");
            confirm(digest, "Withdraw this unsigned approval")?;
            print_response(
                server::call(
                    endpoint,
                    expected_service,
                    Request::RevokeApproval {
                        operation_id: operation.clone(),
                        body_digest: digest.clone(),
                    },
                )
                .await?,
            )
        }
        [command, endpoint, expected_service, kind, operation, digest] if command == "sign" => {
            protocol::body_identity(operation, digest)?;
            let request = match kind.as_str() {
                "release" => Request::SignRelease {
                    operation_id: operation.clone(),
                    body_digest: digest.clone(),
                },
                "revocations" => Request::SignRevocations {
                    operation_id: operation.clone(),
                    body_digest: digest.clone(),
                },
                _ => return Err(protocol::Error("sign_requires_release_or_revocations")),
            };
            print_response(server::call(endpoint, expected_service, request).await?)
        }
        [command, endpoint, expected_service, operation, digest] if command == "query" => {
            protocol::body_identity(operation, digest)?;
            print_response(
                server::call(
                    endpoint,
                    expected_service,
                    Request::Query {
                        operation_id: operation.clone(),
                        body_digest: digest.clone(),
                    },
                )
                .await?,
            )
        }
        [command, endpoint, expected_service, file] if command == "request" => {
            let request: Request =
                protocol::parse(&protocol::read_file(Path::new(file), protocol::MAX_FRAME)?)?;
            if matches!(
                request,
                Request::Approve { .. } | Request::RevokeApproval { .. }
            ) {
                return Err(protocol::Error("use_interactive_approve_or_revoke"));
            }
            print_response(server::call(endpoint, expected_service, request).await?)
        }
        [] => {
            help();
            Ok(())
        }
        [flag] if flag == "--help" || flag == "-h" => {
            help();
            Ok(())
        }
        _ => {
            help();
            Err(protocol::Error("invalid_command_arguments"))
        }
    }
}
fn print_response(response: Response) -> Result<()> {
    println!(
        "{}",
        serde_json::to_string_pretty(&response)
            .map_err(|_| protocol::Error("response_encoding"))?
    );
    if response.state == "unknown" {
        eprintln!("Query the same operation UUID and body SHA-256 to recover its outcome.");
        Err(protocol::Error("operation_outcome_unknown"))
    } else if response.error.is_some() {
        Err(protocol::Error("operation_rejected"))
    } else {
        Ok(())
    }
}

fn require_terminal() -> Result<()> {
    if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
        return Err(protocol::Error("approval_requires_terminal"));
    }
    Ok(())
}

fn confirm(digest: &str, action: &str) -> Result<()> {
    print!("{action} by typing the full SHA-256 (Enter cancels): ");
    io::stdout()
        .flush()
        .map_err(|_| protocol::Error("terminal_unavailable"))?;
    let mut answer = String::new();
    io::stdin()
        .lock()
        .take(130)
        .read_line(&mut answer)
        .map_err(|_| protocol::Error("terminal_unavailable"))?;
    if answer.trim() != digest {
        return Err(protocol::Error("approval_cancelled"));
    }
    Ok(())
}

fn help() {
    println!("hertz-wallpaper-signer\n\
initialize --config <absolute.toml>\n\
serve --config <absolute.toml> [--recovery-proof <absolute-tail.json>]\n\
checkpoint --config <absolute.toml>\n\
approve <local-endpoint> <expected-service-SID-or-UID> <approval.json>\n\
revoke <local-endpoint> <expected-service-SID-or-UID> <operation-UUID> <body-SHA256>\n\
sign <local-endpoint> <expected-service-SID-or-UID> <release|revocations> <operation-UUID> <body-SHA256>\n\
query <local-endpoint> <expected-service-SID-or-UID> <operation-UUID> <body-SHA256>\n\
request <local-endpoint> <expected-service-SID-or-UID> <sign-or-query.json>");
}
