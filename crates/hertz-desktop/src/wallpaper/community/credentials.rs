// SPDX-License-Identifier: MIT
//! Only refresh tokens enter the per-user Windows Credential Manager. Names and
//! blobs bind the confirmed Hub origin, issuer, client and exact subject.
use super::{error, model::SourceProfile};
use crate::wallpaper::jobs::JobError;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows_sys::Win32::Security::Credentials::{
    CredDeleteW, CredFree, CredReadW, CredWriteW, CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE,
    CRED_TYPE_GENERIC,
};
use zeroize::{Zeroize, Zeroizing};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Blob {
    version: u32,
    origin: String,
    issuer: String,
    client_id: String,
    subject: String,
    refresh_token: String,
}
impl Drop for Blob {
    fn drop(&mut self) {
        self.refresh_token.zeroize();
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}

fn name(profile: &SourceProfile, subject: &str) -> Result<String, JobError> {
    profile.validate()?;
    if subject.is_empty() || subject.len() > 255 || subject.chars().any(char::is_control) {
        return Err(error("invalid_subject", "社区账号主体无效"));
    }
    let binding = serde_json::to_vec(&[
        profile.origin.as_str(),
        profile.auth.issuer.as_str(),
        profile.auth.client_id.as_str(),
        subject,
    ])
    .map_err(|_| error("credential_binding", "凭据身份编码失败"))?;
    Ok(format!(
        "Hertz.Wallpaper.Community/{:x}",
        Sha256::digest(binding)
    ))
}

pub(crate) fn write(profile: &SourceProfile, subject: &str, refresh: &str) -> Result<(), JobError> {
    let target = wide(&name(profile, subject)?);
    let blob = Blob {
        version: 1,
        origin: profile.origin.clone(),
        issuer: profile.auth.issuer.clone(),
        client_id: profile.auth.client_id.clone(),
        subject: subject.to_owned(),
        refresh_token: refresh.to_owned(),
    };
    let mut bytes = Zeroizing::new(
        serde_json::to_vec(&blob).map_err(|_| error("credential_encoding", "凭据编码失败"))?,
    );
    if bytes.len() > 2560 {
        return Err(error(
            "credential_limit",
            "刷新凭据超过 Windows 凭据存储上限",
        ));
    }
    let username = wide(subject);
    let credential = CREDENTIALW {
        Flags: 0,
        Type: CRED_TYPE_GENERIC,
        TargetName: target.as_ptr().cast_mut(),
        Comment: std::ptr::null_mut(),
        LastWritten: Default::default(),
        CredentialBlobSize: bytes.len() as u32,
        CredentialBlob: bytes.as_mut_ptr(),
        Persist: CRED_PERSIST_LOCAL_MACHINE,
        AttributeCount: 0,
        Attributes: std::ptr::null_mut(),
        TargetAlias: std::ptr::null_mut(),
        UserName: username.as_ptr().cast_mut(),
    };
    if unsafe { CredWriteW(&credential, 0) } == 0 {
        return Err(error(
            "credential_write_failed",
            "Windows 无法保存社区刷新凭据",
        ));
    }
    Ok(())
}

pub(crate) fn read(
    profile: &SourceProfile,
    subject: &str,
) -> Result<Option<Zeroizing<String>>, JobError> {
    let target = wide(&name(profile, subject)?);
    let mut pointer = std::ptr::null_mut();
    if unsafe { CredReadW(target.as_ptr(), CRED_TYPE_GENERIC, 0, &mut pointer) } == 0 {
        if matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(1168 | 2)
        ) {
            return Ok(None);
        }
        return Err(error("credential_read_failed", "Windows 无法读取社区凭据"));
    }
    struct Allocation(*mut CREDENTIALW);
    impl Drop for Allocation {
        fn drop(&mut self) {
            unsafe { CredFree(self.0.cast()) };
        }
    }
    let allocation = Allocation(pointer);
    let credential = unsafe { &*allocation.0 };
    if credential.CredentialBlobSize == 0
        || credential.CredentialBlobSize > 2560
        || credential.CredentialBlob.is_null()
    {
        return Err(error("credential_invalid", "社区凭据形状无效"));
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(
            credential.CredentialBlob,
            credential.CredentialBlobSize as usize,
        )
    };
    let blob: Blob = serde_json::from_slice(bytes)
        .map_err(|_| error("credential_invalid", "社区凭据编码无效"))?;
    if blob.version != 1
        || blob.origin != profile.origin
        || blob.issuer != profile.auth.issuer
        || blob.client_id != profile.auth.client_id
        || blob.subject != subject
        || blob.refresh_token.is_empty()
    {
        return Err(error(
            "credential_binding",
            "社区凭据与已确认来源及账号不匹配",
        ));
    }
    Ok(Some(Zeroizing::new(blob.refresh_token.clone())))
}

pub(crate) fn delete(profile: &SourceProfile, subject: &str) -> Result<(), JobError> {
    let target = wide(&name(profile, subject)?);
    if unsafe { CredDeleteW(target.as_ptr(), CRED_TYPE_GENERIC, 0) } == 0
        && !matches!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(1168 | 2)
        )
    {
        return Err(error(
            "credential_delete_failed",
            "Windows 无法清除社区凭据",
        ));
    }
    Ok(())
}
