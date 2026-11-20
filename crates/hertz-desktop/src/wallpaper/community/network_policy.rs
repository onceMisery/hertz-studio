// SPDX-License-Identifier: MIT
//! Optional machine-administrator address pins. Pages and Hub responses cannot
//! grant a private connection exception. TLS certificate/name checks still apply.
use super::{contract, error};
use crate::wallpaper::{budget, jobs::JobError};
use serde::Deserialize;
use std::{
    net::{IpAddr, SocketAddr},
    ptr,
};
use windows_sys::Win32::{
    Foundation::{LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS},
    Security::{
        Authorization::{GetSecurityInfo, SE_REGISTRY_KEY},
        GetAce, GetLengthSid, IsValidSid, IsWellKnownSid, WinBuiltinAdministratorsSid,
        WinLocalSystemSid, ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, DACL_SECURITY_INFORMATION,
        OWNER_SECURITY_INFORMATION,
    },
    System::{
        Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
            KEY_WOW64_64KEY, REG_SZ,
        },
        SystemServices::{ACCESS_ALLOWED_ACE_TYPE, ACCESS_DENIED_ACE_TYPE},
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Destination {
    origin: String,
    addresses: Vec<String>,
}

struct Key(HKEY);
impl Drop for Key {
    fn drop(&mut self) {
        unsafe { RegCloseKey(self.0) };
    }
}
struct Security(*mut core::ffi::c_void);
impl Drop for Security {
    fn drop(&mut self) {
        unsafe { LocalFree(self.0) };
    }
}
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(Some(0)).collect()
}
fn trusted_sid(sid: *mut core::ffi::c_void) -> bool {
    unsafe {
        IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
            || IsWellKnownSid(sid, WinLocalSystemSid) != 0
    }
}

fn administrator_key(key: HKEY) -> Result<(), JobError> {
    let mut owner = ptr::null_mut();
    let mut dacl: *mut ACL = ptr::null_mut();
    let mut descriptor = ptr::null_mut();
    let result = unsafe {
        GetSecurityInfo(
            key,
            SE_REGISTRY_KEY,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            ptr::null_mut(),
            &mut dacl,
            ptr::null_mut(),
            &mut descriptor,
        )
    };
    let _security = Security(descriptor);
    if result != ERROR_SUCCESS || owner.is_null() || dacl.is_null() || !trusted_sid(owner) {
        return Err(error(
            "community_policy_acl",
            "固定连接策略必须由 SYSTEM 或 Administrators 持有，并具有受限 ACL",
        ));
    }
    let count = unsafe { (*dacl).AceCount };
    if count > 256 {
        return Err(error("community_policy_acl", "固定连接策略 ACL 超出界限"));
    }
    // Registry writes, deletion, ownership/ACL changes and generic writes may
    // only be granted to machine administrators or SYSTEM. Read grants are fine.
    const WRITES: u32 =
        0x0000_0026 | 0x0001_0000 | 0x0004_0000 | 0x0008_0000 | 0x1000_0000 | 0x4000_0000;
    for index in 0..count {
        let mut ace = ptr::null_mut();
        if unsafe { GetAce(dacl, u32::from(index), &mut ace) } == 0 || ace.is_null() {
            return Err(error("community_policy_acl", "无法读取固定策略 ACL"));
        }
        let header = unsafe { &*ace.cast::<ACE_HEADER>() };
        if u32::from(header.AceType) == ACCESS_DENIED_ACE_TYPE {
            continue;
        }
        if u32::from(header.AceType) != ACCESS_ALLOWED_ACE_TYPE || header.AceSize < 16 {
            return Err(error(
                "community_policy_acl",
                "固定策略 ACL 包含不支持的授权 ACE",
            ));
        }
        let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
        let sid_start = ptr::addr_of!(allowed.SidStart).cast::<u8>();
        let sid_bytes = 8u32 + 4 * u32::from(unsafe { *sid_start.add(1) });
        let sid = sid_start.cast_mut().cast();
        if sid_bytes + 8 > u32::from(header.AceSize)
            || unsafe { IsValidSid(sid) } == 0
            || unsafe { GetLengthSid(sid) } != sid_bytes
        {
            return Err(error("community_policy_acl", "固定策略 ACL 主体无效"));
        }
        if allowed.Mask & WRITES != 0 && !trusted_sid(sid) {
            return Err(error(
                "community_policy_acl",
                "普通主体不能写入固定连接策略",
            ));
        }
    }
    Ok(())
}

pub(super) fn addresses(destination: &reqwest::Url) -> Result<Option<Vec<SocketAddr>>, JobError> {
    let _charge = budget::global()
        .admit_working_bytes(512 * 1024)
        .map_err(|e| error("budget_busy", e.message.to_string()))?;
    let path = wide("SOFTWARE\\Hertz\\WallpaperCommunity\\NetworkPolicy");
    let mut key = ptr::null_mut();
    let opened = unsafe {
        RegOpenKeyExW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            0,
            KEY_READ | KEY_WOW64_64KEY,
            &mut key,
        )
    };
    if matches!(opened, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND) {
        return Ok(None);
    }
    if opened != ERROR_SUCCESS {
        return Err(error(
            "community_policy_unavailable",
            "无法读取本机固定连接策略",
        ));
    }
    let key = Key(key);
    administrator_key(key.0)?;
    let name = wide("PinnedDestinations");
    let mut kind = 0;
    let mut length = 0;
    let found = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            ptr::null(),
            &mut kind,
            ptr::null_mut(),
            &mut length,
        )
    };
    if found == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    if found != ERROR_SUCCESS || kind != REG_SZ || !(2..=65536).contains(&length) || length % 2 != 0
    {
        return Err(error(
            "community_policy_invalid",
            "固定连接策略须为不超过 64 KiB 的 REG_SZ JSON",
        ));
    }
    let mut bytes = vec![0u16; length as usize / 2];
    let read = unsafe {
        RegQueryValueExW(
            key.0,
            name.as_ptr(),
            ptr::null(),
            &mut kind,
            bytes.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if read != ERROR_SUCCESS
        || kind != REG_SZ
        || length as usize > bytes.len() * 2
        || length % 2 != 0
    {
        return Err(error("community_policy_invalid", "固定策略读取期间已变化"));
    }
    bytes.truncate(length as usize / 2);
    if bytes.pop() != Some(0) || bytes.contains(&0) {
        return Err(error(
            "community_policy_invalid",
            "固定策略字符串终止符无效",
        ));
    }
    let text = String::from_utf16(&bytes)
        .map_err(|_| error("community_policy_invalid", "固定策略必须使用有效 Unicode"))?;
    hertz_wallpaper::json::check_bounded_json(text.as_bytes(), 6).map_err(contract)?;
    let entries: Vec<Destination> = serde_json::from_str(&text)
        .map_err(|_| error("community_policy_invalid", "固定策略正文无效"))?;
    if entries.len() > 16 {
        return Err(error("community_policy_invalid", "固定目标不能超过 16 个"));
    }
    let mut origins = std::collections::BTreeSet::new();
    let mut result = None;
    for entry in entries {
        let origin = super::network::canonical_origin(&entry.origin)?;
        if origin != entry.origin
            || !origins.insert(origin.clone())
            || entry.addresses.is_empty()
            || entry.addresses.len() > 16
        {
            return Err(error(
                "community_policy_invalid",
                "固定来源必须唯一、规范且包含 1–16 个地址",
            ));
        }
        let mut pins = Vec::new();
        let mut unique = std::collections::BTreeSet::new();
        for address in entry.addresses {
            if address.len() > 64 {
                return Err(error("community_policy_invalid", "固定地址过长"));
            }
            let ip: IpAddr = address
                .parse()
                .map_err(|_| error("community_policy_invalid", "固定连接只接受确切 IP 地址"))?;
            if ip.is_unspecified() || ip.is_multicast() || !unique.insert(ip) {
                return Err(error("community_policy_invalid", "固定连接地址无效或重复"));
            }
            pins.push(SocketAddr::new(
                ip,
                destination.port_or_known_default().unwrap_or(443),
            ));
        }
        if origin == destination.origin().ascii_serialization() {
            // DNS overrides do not replace a URL's literal IP. Do not turn a
            // mismatched pin into an unrestricted private-address exception.
            if let Some(literal) = destination
                .host_str()
                .and_then(|host| host.trim_matches(['[', ']']).parse::<IpAddr>().ok())
            {
                if pins.len() != 1 || pins[0].ip() != literal {
                    return Err(error(
                        "community_policy_invalid",
                        "IP 来源的固定地址必须与该确切 IP 相同",
                    ));
                }
            }
            result = Some(pins);
        }
    }
    Ok(result)
}
