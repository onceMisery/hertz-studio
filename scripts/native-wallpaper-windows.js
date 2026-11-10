// SPDX-License-Identifier: MIT
// Shared original owned HWND and bounded same-connection quit helper.
module.exports = `param([uint32]$OwnerPid,[ValidateSet('Inspect','Quit')][string]$Mode='Inspect',[string]$PipeName='')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public static class FontTextWindows {
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("kernel32.dll",SetLastError=true)]static extern bool GetNamedPipeServerProcessId(IntPtr pipe,out uint pid);
 public static uint PipeServerPid(IntPtr pipe){uint pid;if(!GetNamedPipeServerProcessId(pipe,out pid))throw new System.ComponentModel.Win32Exception();return pid;}
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int left,top,right,bottom;}
 public class State{public long hwnd,parent;public uint pid;public string parentClass;public bool visible;public RECT rect;}
 public static State[] Read(uint owner){var previousDpi=SetThreadDpiAwarenessContext(new IntPtr(-4));var found=new Dictionary<long,State>();Callback scan=(h,p)=>{
  uint pid;GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(128);GetWindowText(h,title,128);
  if(pid==owner&&title.ToString()=="Hertz wallpaper"){var parent=GetParent(h);var name=new StringBuilder(128);GetClassName(parent,name,128);
   RECT rect;GetWindowRect(h,out rect);found[h.ToInt64()]=new State{hwnd=h.ToInt64(),parent=parent.ToInt64(),pid=pid,
    parentClass=name.ToString(),visible=IsWindowVisible(h),rect=rect};}return true;};
  EnumWindows((h,p)=>{scan(h,p);EnumChildWindows(h,scan,p);return true;},IntPtr.Zero);
  if(previousDpi!=IntPtr.Zero)SetThreadDpiAwarenessContext(previousDpi);
  var result=new State[found.Count];found.Values.CopyTo(result,0);return result;}
}
'@
if($Mode -eq 'Quit'){
 if($OwnerPid -eq 0 -or $PipeName -notmatch '^hertz-desktop-control-[a-zA-Z0-9_-]{0,32}$'){throw 'Invalid owned quit identity'}
 $transactionClock=[Diagnostics.Stopwatch]::StartNew();$timeoutToken=[Threading.CancellationTokenSource]::new();$timeoutToken.CancelAfter(4000)
 function Get-OwnedQuitRemaining{
  $remaining=4000-[int]$transactionClock.ElapsedMilliseconds
  if($remaining -le 0){throw 'Owned quit total transaction deadline'}
  return $remaining
 }
 function Wait-OwnedQuitTask([Threading.Tasks.Task]$operation){
  $remaining=Get-OwnedQuitRemaining
  if(-not $operation.Wait($remaining)){$timeoutToken.Cancel();throw 'Owned quit total transaction deadline'}
  $result=$operation.GetAwaiter().GetResult()
  [void](Get-OwnedQuitRemaining)
  return $result
 }
 $client=[IO.Pipes.NamedPipeClientStream]::new('.',$PipeName,[IO.Pipes.PipeDirection]::InOut,[IO.Pipes.PipeOptions]::Asynchronous)
 try{
  [void](Wait-OwnedQuitTask ($client.ConnectAsync((Get-OwnedQuitRemaining),$timeoutToken.Token)))
  $serverPid=[FontTextWindows]::PipeServerPid($client.SafePipeHandle.DangerousGetHandle())
  if($serverPid -ne $OwnerPid){throw 'Control pipe belongs to another process; no quit bytes were sent'}
  [void](Get-OwnedQuitRemaining)
  $request=[Text.Encoding]::UTF8.GetBytes('{"command":"quit"}')
  [void](Wait-OwnedQuitTask ($client.WriteAsync($request,0,$request.Length,$timeoutToken.Token)))
  [void](Wait-OwnedQuitTask ($client.FlushAsync($timeoutToken.Token)))
  $chunks=[Collections.Generic.List[byte]]::new();$buffer=[byte[]]::new(8192);$reply=$null
  while($null -eq $reply){
   $count=Wait-OwnedQuitTask ($client.ReadAsync($buffer,0,$buffer.Length,$timeoutToken.Token))
   if($count -le 0){throw 'Owned quit ended before complete response'}
   if($chunks.Count+$count -gt 65536){throw 'Owned quit response exceeds original 64 KiB limit'}
   for($index=0;$index -lt $count;$index++){$chunks.Add($buffer[$index])}
   try{$reply=ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($chunks.ToArray())) -ErrorAction Stop}catch{$reply=$null}
  }
  $resultJson=ConvertTo-Json -Compress -Depth 10 -InputObject @{serverPid=$serverPid;response=$reply}
  [void](Get-OwnedQuitRemaining)
  Write-Output $resultJson
 }finally{$timeoutToken.Cancel();$client.Dispose();$timeoutToken.Dispose()}
}else{ConvertTo-Json -Compress -Depth 5 -InputObject @([FontTextWindows]::Read($OwnerPid))}
`;
