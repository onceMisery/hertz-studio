# SPDX-License-Identifier: MIT
# Real OLE drag from an owned fixture form into the exact owned Hertz main window.
param([Parameter(Mandatory=$true)][int]$OwnerPid,[Parameter(Mandatory=$true)][long]$Handle,[Parameter(Mandatory=$true)][string]$Path)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
if(-not [IO.Path]::IsPathRooted($Path) -or -not (Test-Path -LiteralPath $Path)){throw 'Fixture path must exist and be absolute'}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;using System.Drawing;using System.Windows.Forms;using System.Text;using System.Threading;using System.Runtime.InteropServices;
public static class OwnedMusicDrag {
 [StructLayout(LayoutKind.Sequential)]struct RECT{public int left,top,right,bottom;}
 [StructLayout(LayoutKind.Sequential)]struct MOUSEINPUT{public int dx,dy;public uint mouseData,dwFlags,time;public IntPtr dwExtraInfo;}
 [StructLayout(LayoutKind.Sequential)]struct INPUT{public uint type;public MOUSEINPUT mouse;}
 [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out RECT rect);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr h);
 [DllImport("user32.dll")]static extern int GetWindowLong(IntPtr h,int index);
 [DllImport("user32.dll")]static extern bool SetCursorPos(int x,int y);
 [StructLayout(LayoutKind.Sequential)]struct POINT{public int x,y;}
 [DllImport("user32.dll")]static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll")]static extern uint SendInput(uint count,INPUT[] input,int size);
 [DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")]static extern IntPtr GetThreadDpiAwarenessContext();
 [DllImport("user32.dll")]static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
 [DllImport("user32.dll")]static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
 static RECT Validate(uint owner,IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);var title=new StringBuilder(512);GetWindowText(window,title,512);RECT r;if(pid!=owner||title.ToString()!="HertzStudio Music Player"||!IsWindowVisible(window)||IsIconic(window)||!GetWindowRect(window,out r)||r.right-r.left<500||r.bottom-r.top<300)throw new InvalidOperationException("Refusing a target outside the exact owned visible Hertz main window");return r;}
 static void Button(uint flag){var input=new[]{new INPUT{type=0,mouse=new MOUSEINPUT{dwFlags=flag}}};if(SendInput(1,input,Marshal.SizeOf(typeof(INPUT)))!=1)throw new InvalidOperationException("Owned fixture SendInput failed");}
 static void PhysicalDpi(){if(SetThreadDpiAwarenessContext(new IntPtr(-4))==IntPtr.Zero||GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())!=2)throw new InvalidOperationException("Owned pointer thread requires physical per-monitor DPI context");}
 static string Bounds(IntPtr window){RECT r;if(!GetWindowRect(window,out r))return "missing";return r.left+","+r.top+","+r.right+","+r.bottom+" visible="+IsWindowVisible(window)+" enabled="+IsWindowEnabled(window)+" exStyle="+GetWindowLong(window,-20).ToString("X")+" windowDpi="+GetAwarenessFromDpiAwarenessContext(GetWindowDpiAwarenessContext(window));}
 static Point SourceLocation(IntPtr target,RECT r){
  var work=Screen.FromHandle(target).WorkingArea;
  int x=r.right+12;
  if(x+260>work.Right)x=r.left-272;
  if(x<work.Left||x+260>work.Right||work.Height<120)throw new InvalidOperationException("Owned drag fixture needs room beside the target window");
  return new Point(x,Math.Max(work.Top,Math.Min(r.top+90,work.Bottom-120)));
 }
 public static string Run(uint owner,long handle,string path){
  PhysicalDpi();
  IntPtr target=new IntPtr(handle);RECT rectangle=Validate(owner,target);
  if((GetAsyncKeyState(1)&0x8000)!=0||(GetAsyncKeyState(2)&0x8000)!=0)throw new InvalidOperationException("Refusing drag while a mouse button is already held");
  SetForegroundWindow(target);
  string outcome="not-started";Exception failure=null;
  using(var form=new Form()){form.Text="Hertz owned music drag fixture";form.StartPosition=FormStartPosition.Manual;form.Location=SourceLocation(target,rectangle);form.Size=new Size(260,120);
   var label=new Label{Text="Owned music drag verification",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleCenter};form.Controls.Add(label);
   bool started=false;Thread driver=null;
   label.MouseDown+=(sender,e)=>{if(started||e.Button!=MouseButtons.Left)return;started=true;try{var data=new DataObject();data.SetData(DataFormats.FileDrop,new[]{path});outcome=label.DoDragDrop(data,DragDropEffects.Copy).ToString();}catch(Exception error){failure=error;}finally{form.Close();}};
   form.Shown+=(sender,e)=>{
    var sourcePoint=label.PointToScreen(new Point(label.Width/2,label.Height/2));
    var sourceHandle=form.Handle;
    int formDpi=GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext());
    driver=new Thread(()=>{
     bool pressed=false;
     try{
      PhysicalDpi();
      // Show this process's source window after hidden console startup. It sits
      // beside the target and does not need a topmost overlay or foreign focus.
      if(!SetWindowPos(sourceHandle,IntPtr.Zero,0,0,0,0,0x43))throw new InvalidOperationException("Owned source HWND could not be shown");
      Thread.Sleep(200);Validate(owner,target);
      IntPtr sourceAt=GetAncestor(WindowFromPoint(new POINT{x=sourcePoint.X,y=sourcePoint.Y}),2);
      if(sourceAt!=sourceHandle){
       uint coveredPid;GetWindowThreadProcessId(sourceAt,out coveredPid);
       throw new InvalidOperationException("Owned drag source is covered: point="+sourcePoint.X+","+sourcePoint.Y+" expected="+sourceHandle+" actual="+sourceAt+" pid="+coveredPid+" formDpi="+formDpi+" driverDpi="+GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext())+" sourceBounds="+Bounds(sourceHandle)+" targetBounds="+Bounds(target));
      }
      if(!SetCursorPos(sourcePoint.X,sourcePoint.Y))throw new InvalidOperationException("Owned source cursor move failed");
      Button(2);pressed=true;Thread.Sleep(160);
      var currentTarget=Validate(owner,target);
      int x=currentTarget.left+(currentTarget.right-currentTarget.left)*3/4;
      int y=currentTarget.top+(currentTarget.bottom-currentTarget.top)/2;
      if(GetAncestor(WindowFromPoint(new POINT{x=x,y=y}),2)!=target)throw new InvalidOperationException("Owned drop target is covered");
      if(!SetCursorPos(x-45,y-20))throw new InvalidOperationException("Owned drag cursor move failed");
      Thread.Sleep(130);
      if(!SetCursorPos(x,y))throw new InvalidOperationException("Owned drop cursor move failed");
      Thread.Sleep(180);
      if(GetAncestor(WindowFromPoint(new POINT{x=x,y=y}),2)!=target)throw new InvalidOperationException("Owned drop target changed");
      Button(4);pressed=false;
     }catch(Exception error){
      failure=error;
      if(pressed){try{Button(4);}catch{}}
      form.BeginInvoke(new Action(()=>form.Close()));
     }
    });
    driver.IsBackground=true;driver.Start();
   };
   var timeout=new System.Windows.Forms.Timer{Interval=10000};timeout.Tick+=(sender,e)=>{timeout.Stop();failure=new TimeoutException("Owned OLE drag did not complete");try{Button(4);}catch{}form.Close();};timeout.Start();
   Application.Run(form);timeout.Dispose();if(driver!=null&&!driver.Join(3000))throw new TimeoutException("Owned pointer driver did not finish");
  }
  if(failure!=null)throw failure;return outcome;
 }
}
'@
$taskEffect=[OwnedMusicDrag]::Run([uint32]$OwnerPid,$Handle,$Path)
@{effect=$taskEffect;owner=$OwnerPid;target=$Handle;fixture='controlled Windows OLE FileDrop source'}|ConvertTo-Json -Compress
