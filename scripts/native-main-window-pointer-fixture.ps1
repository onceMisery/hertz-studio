# SPDX-License-Identifier: MIT
# Give real mouse focus only to the exact owned native main-window title bar.
param([Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][long]$Handle,[ValidateRange(0,300000)][int]$WaitMilliseconds=0)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;using System.Text;using System.Threading;using System.Runtime.InteropServices;
public static class OwnedMainPointer {
 [StructLayout(LayoutKind.Sequential)]struct POINT{public int x,y;}
 [StructLayout(LayoutKind.Sequential)]struct RECT{public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)]struct MOUSEINPUT{public int dx,dy;public uint data,flags,time;public IntPtr extra;}
 [StructLayout(LayoutKind.Sequential)]struct INPUT{public uint type;public MOUSEINPUT mouse;}
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder title,int size);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int height,uint flags);
 [DllImport("user32.dll")]static extern uint SendInput(uint count,INPUT[] input,int size);
 public static long Focus(uint owner,long handle,int waitMilliseconds){
  if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero)throw new InvalidOperationException("Physical DPI unavailable");
  IntPtr h=new IntPtr(handle);uint pid;GetWindowThreadProcessId(h,out pid);var title=new StringBuilder(512);GetWindowText(h,title,512);RECT r;
  if(pid!=owner||title.ToString()!="HertzStudio Music Player"||!IsWindowVisible(h)||!IsWindowEnabled(h)||IsIconic(h)||!GetWindowRect(h,out r)||r.right-r.left<500)throw new InvalidOperationException("Refusing pointer outside the exact owned visible/enabled main window");
  if((GetAsyncKeyState(1)&0x8000)!=0||(GetAsyncKeyState(2)&0x8000)!=0)throw new InvalidOperationException("Mouse button already held");
  if(!SetWindowPos(h,new IntPtr(-1),0,0,0,0,1|2|16))throw new InvalidOperationException("Owned foreground preparation failed");
  try{Thread.Sleep(100);var timer=System.Diagnostics.Stopwatch.StartNew();POINT point;
   while(true){GetWindowThreadProcessId(h,out pid);title.Clear();GetWindowText(h,title,512);
    if(pid!=owner||title.ToString()!="HertzStudio Music Player"||!IsWindowVisible(h)||!IsWindowEnabled(h)||IsIconic(h)||!GetWindowRect(h,out r)||r.right-r.left<500)throw new InvalidOperationException("Owned main window changed while awaiting pointer admission");
    point=new POINT{x=r.left+80,y=r.top+16};IntPtr at=WindowFromPoint(point);GetWindowThreadProcessId(at,out pid);
    if(pid==owner&&GetAncestor(at,2)==h)break;
    if(timer.ElapsedMilliseconds>=waitMilliseconds){var cover=new StringBuilder(512);GetWindowText(at,cover,512);throw new InvalidOperationException("Refusing a pointer covered by a foreign window: point="+point.x+","+point.y+" target="+handle+" at="+at.ToInt64()+" root="+GetAncestor(at,2).ToInt64()+" pid="+pid+" title="+cover.ToString());}
    Thread.Sleep(200);
   }
   if((GetAsyncKeyState(1)&0x8000)!=0||(GetAsyncKeyState(2)&0x8000)!=0)throw new InvalidOperationException("Mouse button already held");
   if(!SetCursorPos(point.x,point.y))throw new InvalidOperationException("Owned cursor move failed");
   var input=new[]{new INPUT{mouse=new MOUSEINPUT{flags=2}},new INPUT{mouse=new MOUSEINPUT{flags=4}}};if(SendInput(2,input,Marshal.SizeOf(typeof(INPUT)))!=2)throw new InvalidOperationException("Owned mouse click failed");Thread.Sleep(100);
   return GetForegroundWindow().ToInt64();
  }finally{SetWindowPos(h,new IntPtr(-2),0,0,0,0,1|2|16);}
 }
}
'@
$taskForeground=[OwnedMainPointer]::Focus([uint32]$OwnerPid,$Handle,$WaitMilliseconds)
@{foreground=$taskForeground;owner=$OwnerPid;target=$Handle;input='actual owned title-bar mouse click'}|ConvertTo-Json -Compress
