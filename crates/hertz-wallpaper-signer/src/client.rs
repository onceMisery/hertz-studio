// SPDX-License-Identifier: MIT
//! The Hub-facing client exposes only the two signing operations and queries.
use crate::{
    platform,
    protocol::{self, Request, Response, Result},
    server,
};

#[derive(Clone)]
pub struct HubClient {
    endpoint: String,
    service_identity: String,
}

impl HubClient {
    pub fn new(endpoint: String, service_identity: String) -> Result<Self> {
        platform::validate_identity(&service_identity)?;
        platform::validate_endpoint(&endpoint, None)?;
        Ok(Self {
            endpoint,
            service_identity,
        })
    }

    pub async fn query(&self, operation_id: &str, body_digest: &str) -> Result<Response> {
        protocol::body_identity(operation_id, body_digest)?;
        server::call(
            &self.endpoint,
            &self.service_identity,
            Request::Query {
                operation_id: operation_id.to_owned(),
                body_digest: body_digest.to_owned(),
            },
        )
        .await
    }

    pub async fn sign_release(&self, operation_id: &str, body_digest: &str) -> Result<Response> {
        protocol::body_identity(operation_id, body_digest)?;
        server::call(
            &self.endpoint,
            &self.service_identity,
            Request::SignRelease {
                operation_id: operation_id.to_owned(),
                body_digest: body_digest.to_owned(),
            },
        )
        .await
    }

    pub async fn sign_revocations(
        &self,
        operation_id: &str,
        body_digest: &str,
    ) -> Result<Response> {
        protocol::body_identity(operation_id, body_digest)?;
        server::call(
            &self.endpoint,
            &self.service_identity,
            Request::SignRevocations {
                operation_id: operation_id.to_owned(),
                body_digest: body_digest.to_owned(),
            },
        )
        .await
    }
}
