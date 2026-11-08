# SPDX-License-Identifier: MIT
# Read-only WCT evidence for an explicitly selected private sandbox candidate.
param([Parameter(Mandatory=$true)][uint32]$OwnerPid,[string]$EvidencePath)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$taskProcess=Get-Process -Id $OwnerPid
$taskExpectedRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\output\a05-g3s-20261108'))
$taskActualPath=[IO.Path]::GetFullPath($taskProcess.Path)
$taskOwned=$taskActualPath.StartsWith($taskExpectedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
if(-not $taskOwned -and $EvidencePath) {
  $taskReceiptPath=[IO.Path]::GetFullPath($EvidencePath)
  if(-not $taskReceiptPath.StartsWith($taskExpectedRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) {
    throw 'Worker evidence must be inside the owned A05 diagnostic directory'
  }
  $taskReceipt=Get-Content -LiteralPath $taskReceiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $taskExpectedPath=[string]$taskReceipt.stagedBinary.path
  if($taskExpectedPath.StartsWith('\\?\')){$taskExpectedPath=$taskExpectedPath.Substring(4)}
  $taskHash=(Get-FileHash -LiteralPath $taskActualPath -Algorithm SHA256).Hash
  $taskOwned=($OwnerPid -eq $taskReceipt.worker.pid -and
    [uint64]$taskProcess.StartTime.ToUniversalTime().ToFileTimeUtc() -eq [uint64]$taskReceipt.worker.created -and
    $taskActualPath -eq $taskExpectedPath -and $taskHash -eq $taskReceipt.stagedBinary.sha256)
}
if(-not $taskOwned) {
  throw 'Wait-chain target must be an owned A05 diagnostic candidate'
}
$taskCreation=$taskProcess.StartTime.ToUniversalTime().ToString('o')
$taskThreads=@($taskProcess.Threads | Select-Object -First 32)
Add-Type @'
using System;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class WallpaperWaitChain {
 [DllImport("advapi32.dll",SetLastError=true)]static extern IntPtr OpenThreadWaitChainSession(uint flags,IntPtr callback);
 [DllImport("advapi32.dll",SetLastError=true)][return:MarshalAs(UnmanagedType.Bool)]
 static extern bool GetThreadWaitChain(IntPtr session,IntPtr context,uint flags,uint threadId,ref uint count,IntPtr nodes,[MarshalAs(UnmanagedType.Bool)]out bool cycle);
 [DllImport("advapi32.dll")]static extern void CloseThreadWaitChainSession(IntPtr session);
 public static object Read(uint threadId) {
  var session=OpenThreadWaitChainSession(0,IntPtr.Zero);
  if(session==IntPtr.Zero)throw new Exception("OpenThreadWaitChainSession: "+Marshal.GetLastWin32Error());
  // WAITCHAIN_NODE_INFO: two DWORD enums followed by the 272-byte union.
  const int nodeSize=280;var memory=Marshal.AllocHGlobal(nodeSize*16);
  try {
   uint count=16;bool cycle;var ok=GetThreadWaitChain(session,IntPtr.Zero,7,threadId,ref count,memory,out cycle);
   int error=ok?0:Marshal.GetLastWin32Error();var result=new List<object>();
   if(ok)for(int index=0;index<Math.Min(count,16);index++) {
    var node=IntPtr.Add(memory,index*nodeSize);int type=Marshal.ReadInt32(node),status=Marshal.ReadInt32(node,4);
    if(type==8)result.Add(new{type,status,pid=(uint)Marshal.ReadInt32(node,8),tid=(uint)Marshal.ReadInt32(node,12),waitTime=(uint)Marshal.ReadInt32(node,16),contextSwitches=(uint)Marshal.ReadInt32(node,20)});
    else {var name=Marshal.PtrToStringUni(IntPtr.Add(node,8),128)??"";int end=name.IndexOf('\0');if(end>=0)name=name.Substring(0,end);result.Add(new{type,status,objectName=name});}
   }
   return new{threadId,ok,error,cycle,count,nodes=result.ToArray()};
  }finally{Marshal.FreeHGlobal(memory);CloseThreadWaitChainSession(session);}
 }
}
'@
$taskSnapshots=@()
foreach($taskThread in $taskThreads){$taskSnapshots+=[WallpaperWaitChain]::Read([uint32]$taskThread.Id)}
# Recheck the exact selected process object after reading; a reused PID is not evidence.
$taskAfter=Get-Process -Id $OwnerPid
if($taskAfter.StartTime.ToUniversalTime().ToString('o') -ne $taskCreation -or $taskAfter.Path -ne $taskProcess.Path){throw 'Wait-chain target identity changed'}
@{pid=$OwnerPid;path=$taskActualPath;createdUtc=$taskCreation;capturedUtc=[DateTime]::UtcNow.ToString('o');
  threadLimit=32;threads=@($taskSnapshots)}|ConvertTo-Json -Depth 8 -Compress
