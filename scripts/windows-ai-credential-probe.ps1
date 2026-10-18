# SPDX-License-Identifier: MIT
# Test helper: exact, isolated AI targets only; never enumerate or print secrets.
# The JSON request is passed on stdin, never as a command-line argument.
$ErrorActionPreference = 'Stop'
try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.scope -notmatch '^ai_provider_cred_v1_[a-f0-9]{64}$') { throw 'invalid fixture scope' }
    if ($request.service -notin @('hertz-studio-standard', 'hertz-studio', 'mmusic-studio')) { throw 'invalid fixture service' }
    if ($request.operation -notin @('read', 'put-raw', 'put-device', 'delete')) { throw 'invalid fixture operation' }
    if ($request.operation -in @('put-raw', 'put-device') -and $request.expectedKey -notmatch '^fixture-keyring-[a-f0-9-]+$') { throw 'fixture values only' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class HertzCredentialFixture {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public string TargetName, Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool ReadNative(string target, uint type, uint flags, out IntPtr result);
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool WriteNative(ref Credential value, uint flags);
    [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool DeleteNative(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
    public static string Read(string target) {
        IntPtr buffer;
        if (!ReadNative(target, 1, 0, out buffer)) {
            if (Marshal.GetLastWin32Error() == 1168) return null;
            throw new InvalidOperationException("native fixture read failed");
        }
        try {
            var credential = Marshal.PtrToStructure<Credential>(buffer);
            byte[] bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            try { return Encoding.Unicode.GetString(bytes); }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        } finally { CredFree(buffer); }
    }
    public static void Write(string target, string value) {
        byte[] bytes = Encoding.Unicode.GetBytes(value);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        try {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential { Type=1, TargetName=target, UserName="Hertz isolated fixture",
                CredentialBlobSize=(uint)bytes.Length, CredentialBlob=blob, Persist=3 };
            if (!WriteNative(ref credential, 0)) throw new InvalidOperationException("native fixture write failed");
        } finally {
            Array.Clear(bytes, 0, bytes.Length);
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            Marshal.FreeHGlobal(blob);
        }
    }
    public static void Delete(string target) {
        if (!DeleteNative(target, 1, 0) && Marshal.GetLastWin32Error() != 1168)
            throw new InvalidOperationException("native fixture delete failed");
    }
}
'@
    $target = $request.scope + ':cred.' + $request.service
    if ($request.operation -eq 'delete') {
        [HertzCredentialFixture]::Delete($target)
        [HertzCredentialFixture]::Delete($request.scope + ':device.' + $request.service)
        @{ deleted = $true } | ConvertTo-Json -Compress
    } elseif ($request.operation -eq 'put-raw') {
        [HertzCredentialFixture]::Write($target, $request.expectedKey)
        @{ written = $true } | ConvertTo-Json -Compress
    } elseif ($request.operation -eq 'put-device') {
        [HertzCredentialFixture]::Write($request.scope + ':device.' + $request.service, $request.expectedKey)
        @{ written = $true } | ConvertTo-Json -Compress
    } else {
        $value = [HertzCredentialFixture]::Read($target)
        $device = [HertzCredentialFixture]::Read($request.scope + ':device.' + $request.service)
        $record = $null
        $prefix = "hertz-ai-credential-v1`n"
        if ($null -ne $value -and $value.StartsWith($prefix)) {
            $record = $value.Substring($prefix.Length) | ConvertFrom-Json
        }
        $matches = if ($null -ne $record) {
            $record.scope -ceq $request.scope -and $record.api_key -ceq $request.expectedKey
        } else { $null -ne $value -and $value -ceq $request.expectedKey }
        @{ exists = $null -ne $value; deviceExists = $null -ne $device; envelope = $null -ne $record; matches = $matches;
            generation = $(if ($null -ne $record) { $record.generation } else { $null }) } | ConvertTo-Json -Compress
    }
} catch {
    [Console]::Error.WriteLine('Windows credential fixture operation failed; no input or credential diagnostics emitted.')
    exit 1
}
