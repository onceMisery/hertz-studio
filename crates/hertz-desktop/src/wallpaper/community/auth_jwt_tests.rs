// SPDX-License-Identifier: MIT
//! This public test key is generated for fixtures and is never a deployed credential.
use super::super::super::test_support::Authority;
use super::*;
use jsonwebtoken::{EncodingKey, Header};
use serde_json::{json, Value};

const PRIVATE_KEY_B64: &str = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgUPitx10GpqT2B9K+UoWeOAVqgI7mFjKathBk6b2W6cChRANCAATj2vaJ7PgZylaVkoqcIbvKFTVhup0XOdjN2rB8e+04E7ov4X9j4SBsHCcQrhBnAzU4rl680UjLUcADcPQnxIpW";
const JWK: &str = r#"{"kty":"EC","x":"49r2iez4GcpWlZKKnCG7yhU1YbqdFznYzdqwfHvtOBM","y":"ui_hf2PhIGwcJxCuEGcDNTiuXrzRSMtRwANw9CfEilY","crv":"P-256","kid":"native-oidc-fixture","alg":"ES256","use":"sig","key_ops":["verify"]}"#;

fn key() -> EncodingKey {
    EncodingKey::from_ec_der(
        &base64::engine::general_purpose::STANDARD
            .decode(PRIVATE_KEY_B64)
            .unwrap(),
    )
}
fn profile() -> SourceProfile {
    let mut profile = Authority::new("https://community.example").profile;
    profile.auth.algorithms = vec!["ES256".into()];
    profile
}
fn claims(profile: &SourceProfile) -> Value {
    json!({"iss":profile.auth.issuer,"sub":"fixture-subject","aud":profile.auth.audience,
        "nbf":now()-1,"exp":now()+900,"scope":"wallpaper.read wallpaper.write","token_use":"access"})
}
fn header() -> Header {
    let mut header = Header::new(Algorithm::ES256);
    header.typ = Some("at+jwt".into());
    header.kid = Some("native-oidc-fixture".into());
    header
}
fn token(claims: &Value) -> String {
    jsonwebtoken::encode(&header(), claims, &key()).unwrap()
}
async fn verifier(profile: &SourceProfile, jwk: Value) -> Verifier {
    let verifier = Verifier::default();
    verifier.cache.lock().await.insert(
        profile.source_id.clone(),
        KeyCache {
            keys: serde_json::from_value(json!({"keys":[jwk]})).unwrap(),
            expires: Instant::now() + Duration::from_secs(3600),
            attempted: Instant::now(),
        },
    );
    verifier
}

#[tokio::test]
async fn cached_signed_access_token_accepts_only_the_configured_subject_and_api_audience() {
    let profile = profile();
    let verifier = verifier(&profile, serde_json::from_str(JWK).unwrap()).await;
    let mut claims = claims(&profile);
    let identity = verifier.verify(&profile, &token(&claims)).await.unwrap();
    assert_eq!(identity.subject, "fixture-subject");
    assert_eq!(identity.expires, claims["exp"].as_u64().unwrap());
    claims["aud"] = json!([profile.auth.audience]);
    verifier.verify(&profile, &token(&claims)).await.unwrap();
}

#[tokio::test]
async fn signed_id_tokens_wrong_issuer_audience_scopes_and_times_are_rejected() {
    let profile = profile();
    let verifier = verifier(&profile, serde_json::from_str(JWK).unwrap()).await;
    for variant in [
        "issuer",
        "client_audience",
        "multiple_audiences",
        "id_token",
        "nonce",
        "scope",
        "expired",
        "future_nbf",
        "empty_subject",
        "control_subject",
    ] {
        let mut claims = claims(&profile);
        match variant {
            "issuer" => claims["iss"] = json!("https://other.example/oidc"),
            "client_audience" => claims["aud"] = json!(profile.auth.client_id),
            "multiple_audiences" => claims["aud"] = json!([profile.auth.audience, "other-api"]),
            "id_token" => claims["token_use"] = json!("id"),
            "nonce" => claims["nonce"] = json!("id-token-nonce"),
            "scope" => claims["scope"] = json!("wallpaper.read"),
            "expired" => claims["exp"] = json!(now() - 1),
            "future_nbf" => claims["nbf"] = json!(now() + 600),
            "empty_subject" => claims["sub"] = json!(""),
            _ => claims["sub"] = json!("invalid\nsubject"),
        }
        match verifier.verify(&profile, &token(&claims)).await {
            Err(error) => assert_eq!(error.code, "access_token_invalid", "{variant}"),
            Ok(_) => panic!("invalid signed token accepted: {variant}"),
        }
    }
}

#[tokio::test]
async fn jwks_key_purpose_and_algorithm_must_match_the_signed_token() {
    let profile = profile();
    for variant in ["algorithm", "use", "operations", "curve"] {
        let mut jwk: Value = serde_json::from_str(JWK).unwrap();
        match variant {
            "algorithm" => jwk["alg"] = json!("RS256"),
            "use" => jwk["use"] = json!("enc"),
            "operations" => jwk["key_ops"] = json!(["sign"]),
            _ => jwk["crv"] = json!("P-384"),
        }
        let verifier = verifier(&profile, jwk).await;
        match verifier.verify(&profile, &token(&claims(&profile))).await {
            Err(error) => assert_eq!(error.code, "jwks_invalid", "{variant}"),
            Ok(_) => panic!("invalid key purpose accepted: {variant}"),
        }
    }
}

#[tokio::test]
async fn unknown_kid_is_rate_limited_without_reusing_a_different_cached_key() {
    let profile = profile();
    let verifier = verifier(&profile, serde_json::from_str(JWK).unwrap()).await;
    let mut header = header();
    header.kid = Some("unknown-key".into());
    let token = jsonwebtoken::encode(&header, &claims(&profile), &key()).unwrap();
    match verifier.verify(&profile, &token).await {
        Err(error) => assert_eq!(error.code, "jwks_refresh_limited"),
        Ok(_) => panic!("unknown key accepted"),
    }
}

#[tokio::test]
async fn signature_mutation_opaque_and_symmetric_tokens_are_rejected() {
    let profile = profile();
    let verifier = verifier(&profile, serde_json::from_str(JWK).unwrap()).await;
    let valid = token(&claims(&profile));
    let mut fields: Vec<String> = valid.split('.').map(String::from).collect();
    let replacement = if fields[2].starts_with('A') { "B" } else { "A" };
    fields[2].replace_range(..1, replacement);
    let hs = jsonwebtoken::encode(
        &Header::new(Algorithm::HS256),
        &claims(&profile),
        &EncodingKey::from_secret(b"public-test-secret"),
    )
    .unwrap();
    for invalid in [
        fields.join("."),
        "opaque-token".into(),
        hs,
        "x".repeat(16385),
    ] {
        match verifier.verify(&profile, &invalid).await {
            Err(error) => assert_eq!(error.code, "access_token_invalid"),
            Ok(_) => panic!("unverified token accepted"),
        }
    }
}
