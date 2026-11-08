# SPDX-License-Identifier: MIT
# UI Automation locates controls; actual SendInput is restricted to this owned window.
param([Parameter(Mandatory=$true)][uint32]$OwnerPid,
      [ValidateSet('inspect','options','calibrate')][string]$Action='inspect')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type @'
using System;using System.Text;using System.Threading;using System.Runtime.InteropServices;
public static class OwnedLyricsPointer {
 // Keep this source ASCII: Windows PowerShell 5.1 decodes BOM-less files as ANSI.
 public const string WindowTitle="Hertz \u684c\u9762\u6b4c\u8bcd";
 public delegate bool Callback(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential)]public struct POINT {public int x,y;}
 [StructLayout(LayoutKind.Sequential)]public struct RECT {public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)]public struct MOUSEINPUT {public int x,y;public uint data,flags,time;public IntPtr extra;}
 [StructLayout(LayoutKind.Sequential)]public struct INPUT {public uint type;public MOUSEINPUT mouse;}
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT p);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flag);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT rect);
 [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]static extern uint SendInput(uint count,INPUT[] input,int size);
 public static IntPtr Find(uint owner) {
  SetThreadDpiAwarenessContext(new IntPtr(-4));IntPtr found=IntPtr.Zero;
  EnumWindows((h,p)=>{uint pid;GetWindowThreadProcessId(h,out pid);if(pid==owner){
    var title=new StringBuilder(256);GetWindowText(h,title,title.Capacity);
    if(title.ToString()==WindowTitle)found=h;}return true;},IntPtr.Zero);
  if(found==IntPtr.Zero)throw new Exception("Owned lyrics HWND missing");return found;
 }
 static void Validate(uint owner,IntPtr hwnd,int x,int y) {
  uint pid;GetWindowThreadProcessId(hwnd,out pid);
  var title=new StringBuilder(256);GetWindowText(hwnd,title,title.Capacity);
  if(pid!=owner||title.ToString()!=WindowTitle||!IsWindowVisible(hwnd)||!IsWindowEnabled(hwnd))
    throw new Exception("Owned lyrics window changed or is hidden");
  var at=WindowFromPoint(new POINT{x=x,y=y});var root=GetAncestor(at,2);
  uint childPid,rootPid;GetWindowThreadProcessId(at,out childPid);GetWindowThreadProcessId(root,out rootPid);
  // WebView2 children can belong to its browser process. The actual root must
  // still be this exact owned host; another same-PID window is also rejected.
  if(root!=hwnd||rootPid!=owner)throw new Exception("Refusing input covered by another window: point="+x+","+y+" childPid="+childPid+" rootPid="+rootPid+" root="+root+" expected="+hwnd);
 }
 public static void Hover(uint owner,IntPtr hwnd) {
  RECT rect;if(!GetWindowRect(hwnd,out rect))throw new Exception("Owned window bounds unavailable");
  int x=rect.left+(rect.right-rect.left)/2,y=rect.top+(rect.bottom-rect.top)/2;
  Validate(owner,hwnd,x,y);
  if(!SetCursorPos(x,y))throw new Exception("Owned hover move failed");
  Thread.Sleep(300);
 }
 public static void Click(uint owner,IntPtr hwnd,int x,int y) {
  Validate(owner,hwnd,x,y);
  if((GetAsyncKeyState(1)&0x8000)!=0||(GetAsyncKeyState(2)&0x8000)!=0)throw new Exception("Mouse button already held");
  if(!SetCursorPos(x,y))throw new Exception("Owned pointer move failed");
  Validate(owner,hwnd,x,y);
  var input=new[]{new INPUT{mouse=new MOUSEINPUT{flags=2}},new INPUT{mouse=new MOUSEINPUT{flags=4}}};
  if(SendInput(2,input,Marshal.SizeOf(typeof(INPUT)))!=2)throw new Exception("Owned click incomplete");
  Thread.Sleep(100);
 }
}
'@
$taskHwnd=[OwnedLyricsPointer]::Find($OwnerPid)
if($Action -eq 'options'){[OwnedLyricsPointer]::Hover($OwnerPid,$taskHwnd)}
$taskElement=[System.Windows.Automation.AutomationElement]::FromHandle($taskHwnd)
$taskScope=[System.Windows.Automation.TreeScope]::Descendants
$taskButtons=[System.Windows.Automation.PropertyCondition]::new(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$taskControls=$taskElement.FindAll($taskScope,$taskButtons)
$taskCalibrate=[regex]::Unescape('\u5728\u64ad\u653e\u5668\u6821\u51c6')
$taskOptions=[regex]::Unescape('\u6b4c\u8bcd\u8bbe\u7f6e')
$taskNames=@($taskCalibrate,[regex]::Unescape('\u6b63\u5728\u6253\u5f00'),
  [regex]::Unescape('\u91cd\u8bd5')+$taskCalibrate)
if($Action -ne 'inspect') {
  $taskButton=$null
  foreach($taskControl in $taskControls) {
    if(($Action -eq 'options' -and $taskControl.Current.Name -eq $taskOptions) -or
       ($Action -eq 'calibrate' -and $taskControl.Current.Name -eq $taskCalibrate)) {
      if($null -ne $taskButton){throw 'Ambiguous owned control'}
      $taskButton=$taskControl
    }
  }
  if($null -eq $taskButton){throw 'Owned control missing'}
  if(-not $taskButton.Current.IsEnabled){throw 'Owned control disabled'}
  if($taskButton.Current.IsOffscreen) {
    $taskScroll=$taskButton.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
    $taskScroll.ScrollIntoView()
  }
  $taskRect=$taskButton.Current.BoundingRectangle
  if($taskRect.IsEmpty -or $taskRect.Width -le 0 -or $taskRect.Height -le 0){throw 'Owned control has no clickable bounds'}
  [OwnedLyricsPointer]::Click($OwnerPid,$taskHwnd,[int]($taskRect.X+$taskRect.Width/2),[int]($taskRect.Y+$taskRect.Height/2))
  $taskControls=$taskElement.FindAll($taskScope,$taskButtons)
}
$taskResult=@()
foreach($taskControl in $taskControls) {
  if($taskNames -contains $taskControl.Current.Name) {
    $taskResult+=@{name=$taskControl.Current.Name;enabled=$taskControl.Current.IsEnabled;
      offscreen=$taskControl.Current.IsOffscreen;automationId=$taskControl.Current.AutomationId}
  }
}
@{owner=$OwnerPid;hwnd=$taskHwnd.ToInt64();action=$Action;calibration=@($taskResult)}|ConvertTo-Json -Depth 4 -Compress
