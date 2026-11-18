// SPDX-License-Identifier: MIT
use std::{
    ffi::c_void,
    fs::{File, OpenOptions},
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        fs::OpenOptionsExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::Path,
    ptr::null_mut,
};

use windows_sys::Win32::{
    Foundation::{LocalFree, HANDLE},
    Security::{
        AclSizeInformation,
        Authorization::{
            ConvertSidToStringSidW, ConvertStringSidToSidW, GetSecurityInfo, SE_FILE_OBJECT,
        },
        GetAce, GetAclInformation, GetLengthSid, GetTokenInformation, IsValidSid, TokenUser,
        ACCESS_ALLOWED_ACE, ACE_HEADER, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
        INHERIT_ONLY_ACE, OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
    },
    Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_FLAG_WRITE_THROUGH, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE, FILE_SHARE_READ,
        FILE_SHARE_WRITE,
    },
    System::Threading::{GetCurrentProcess, OpenProcessToken},
};

use crate::protocol::{Error, Result};

pub(super) const READ_CONTROL: u32 = 0x0002_0000;
pub(super) struct LocalAllocation(pub *mut c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.0);
        }
    }
}

pub fn restrict_process_files() {}

pub(super) fn wide(value: &std::ffi::OsStr) -> Result<Vec<u16>> {
    let mut value: Vec<u16> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(Error("invalid_path_encoding"));
    }
    value.push(0);
    Ok(value)
}

pub(super) unsafe fn sid_text(sid: *mut c_void) -> Result<String> {
    if sid.is_null() || unsafe { IsValidSid(sid) } == 0 {
        return Err(Error("invalid_os_sid"));
    }
    let mut pointer = null_mut();
    if unsafe { ConvertSidToStringSidW(sid, &mut pointer) } == 0 {
        return Err(Error("os_identity_unavailable"));
    }
    let _allocation = LocalAllocation(pointer.cast());
    let mut length = 0;
    while length < 256 && unsafe { *pointer.add(length) } != 0 {
        length += 1;
    }
    if length == 256 {
        return Err(Error("invalid_os_sid"));
    }
    String::from_utf16(unsafe { std::slice::from_raw_parts(pointer, length) })
        .map_err(|_| Error("invalid_os_sid"))
}

pub fn validate_identity(identity: &str) -> Result<()> {
    if identity.len() > 256 {
        return Err(Error("canonical_sid_required"));
    }
    let value = wide(std::ffi::OsStr::new(identity))?;
    let mut pointer = null_mut();
    if unsafe { ConvertStringSidToSidW(value.as_ptr(), &mut pointer) } == 0 {
        return Err(Error("canonical_sid_required"));
    }
    let _allocation = LocalAllocation(pointer);
    if unsafe { sid_text(pointer)? } != identity {
        return Err(Error("canonical_sid_required"));
    }
    Ok(())
}

pub(super) fn token_identity(token: HANDLE) -> Result<String> {
    let mut size = 0;
    unsafe {
        GetTokenInformation(token, TokenUser, null_mut(), 0, &mut size);
    }
    if size < size_of::<TOKEN_USER>() as u32 || size > 65_536 {
        return Err(Error("os_identity_unavailable"));
    }
    let mut storage = vec![0usize; (size as usize).div_ceil(size_of::<usize>())];
    if unsafe {
        GetTokenInformation(
            token,
            TokenUser,
            storage.as_mut_ptr().cast(),
            size,
            &mut size,
        )
    } == 0
    {
        return Err(Error("os_identity_unavailable"));
    }
    let user = unsafe { &*storage.as_ptr().cast::<TOKEN_USER>() };
    unsafe { sid_text(user.User.Sid) }
}

pub(super) fn process_identity(process: HANDLE) -> Result<String> {
    let mut token = null_mut();
    if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
        return Err(Error("os_identity_unavailable"));
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    token_identity(token.as_raw_handle())
}

pub fn current_identity() -> Result<String> {
    process_identity(unsafe { GetCurrentProcess() })
}

fn trusted_system_owner(owner: &str) -> bool {
    matches!(owner, "S-1-5-18" | "S-1-5-32-544")
}

fn check_acl(file: &File, identity: &str, private: bool) -> Result<()> {
    let mut owner = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    if unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut dacl,
            null_mut(),
            &mut descriptor,
        )
    } != 0
    {
        return Err(Error("file_security_unavailable"));
    }
    let _allocation = LocalAllocation(descriptor);
    let owner = unsafe { sid_text(owner)? };
    if (private && owner != identity)
        || (!private && owner != identity && !trusted_system_owner(&owner))
        || dacl.is_null()
    {
        return Err(Error("untrusted_file_owner_or_acl"));
    }
    let mut information: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        GetAclInformation(
            dacl,
            (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
            size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
        || information.AceCount > 1024
    {
        return Err(Error("file_security_unavailable"));
    }
    for index in 0..information.AceCount {
        let mut pointer = null_mut();
        if unsafe { GetAce(dacl, index, &mut pointer) } == 0 {
            return Err(Error("file_security_unavailable"));
        }
        let header = unsafe { &*pointer.cast::<ACE_HEADER>() };
        // Deny ACEs do not grant authority. Other ACE encodings fail closed rather
        // than guessing about callback/object/conditional authorization.
        if header.AceType == 1 {
            continue;
        }
        if header.AceType != 0 || header.AceSize < size_of::<ACCESS_ALLOWED_ACE>() as u16 {
            return Err(Error("unsupported_file_acl"));
        }
        if !private && u32::from(header.AceFlags) & INHERIT_ONLY_ACE != 0 {
            continue;
        }
        let ace = unsafe { &*pointer.cast::<ACCESS_ALLOWED_ACE>() };
        let sid = (&ace.SidStart as *const u32).cast_mut().cast();
        if unsafe { IsValidSid(sid) } == 0
            || unsafe { GetLengthSid(sid) } as usize + 8 > header.AceSize as usize
        {
            return Err(Error("unsupported_file_acl"));
        }
        let subject = unsafe { sid_text(sid)? };
        if subject == identity || (!private && trusted_system_owner(&subject)) {
            continue;
        }
        // On ancestors deny any untrusted namespace/ACL mutation. On private
        // objects additionally deny reading contents or inheriting such access.
        let writes = 0x500d_0156u32; // GENERIC_ALL/WRITE, DELETE, WRITE_DAC/OWNER, data/EA/attributes/delete-child.
        let reads = 0x8000_0089u32; // GENERIC_READ, read data/EA/attributes.
        if ace.Mask & (writes | if private { reads } else { 0 }) != 0 {
            return Err(Error("private_file_acl_required"));
        }
    }
    Ok(())
}

fn metadata_file(path: &Path) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
        .map_err(Into::into)
}

fn information(file: &File) -> Result<BY_HANDLE_FILE_INFORMATION> {
    let mut information = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut information) } == 0 {
        return Err(Error("file_metadata_unavailable"));
    }
    if information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(Error("redirected_storage_not_allowed"));
    }
    Ok(information)
}

fn check_ancestors(path: &Path, identity: &str) -> Result<()> {
    for ancestor in path.ancestors().skip(1) {
        if ancestor.parent().is_none() && ancestor.as_os_str().is_empty() {
            continue;
        }
        let file = metadata_file(ancestor)?;
        if information(&file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
            return Err(Error("nonredirected_directory_required"));
        }
        check_acl(&file, identity, false)?;
    }
    Ok(())
}

pub fn check_directory(path: &Path, identity: &str, private: bool) -> Result<()> {
    crate::config::absolute(path)?;
    validate_identity(identity)?;
    check_ancestors(path, identity)?;
    let file = metadata_file(path)?;
    if information(&file)?.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(Error("nonredirected_directory_required"));
    }
    check_acl(&file, identity, private)
}

fn check_file(file: &File, identity: &str) -> Result<()> {
    let information = information(file)?;
    if information.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
        || information.nNumberOfLinks != 1
    {
        return Err(Error("private_regular_file_required"));
    }
    check_acl(file, identity, true)
}

pub fn private_file(path: &Path, identity: &str, append: bool) -> Result<File> {
    crate::config::absolute(path)?;
    check_ancestors(path, identity)?;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH);
    if append {
        options.append(true);
    }
    let file = options.open(path)?;
    check_file(&file, identity)?;
    Ok(file)
}

pub fn create_private_file(path: &Path, identity: &str) -> Result<File> {
    crate::config::absolute(path)?;
    check_directory(
        path.parent().ok_or(Error("invalid_storage_path"))?,
        identity,
        true,
    )?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .share_mode(FILE_SHARE_READ)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH)
        .open(path)?;
    check_file(&file, identity)?;
    Ok(file)
}

// Windows records use FILE_FLAG_WRITE_THROUGH and File::sync_all; Windows has no
// portable POSIX directory fsync. Missing signed checkpoints still fail startup.
pub fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

pub fn validate_endpoint(endpoint: &str, _service: Option<&str>) -> Result<()> {
    let name = endpoint
        .strip_prefix(r"\\.\pipe\hertz-wallpaper-signer-")
        .ok_or(Error("local_signer_pipe_required"))?;
    if name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(Error("invalid_local_endpoint"));
    }
    Ok(())
}
