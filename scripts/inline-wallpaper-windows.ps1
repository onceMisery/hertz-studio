param([int]$TargetPid, [string]$ScreenshotPath)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type @'
using System; using System.Text; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class WallpaperSettingWindows {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 public delegate bool Callback(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h,Callback c,IntPtr p);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder t,int size);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h,ref Point p);
 [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h,uint command);
 [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h,out uint color,out byte alpha,out uint flags);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 public class Info { public long Handle,Parent; public uint ProcessId; public string Title; public bool Visible,Child; public int Alpha; public Rect Bounds,Client; public List<long> OccludingSiblings; }
 static void Add(List<Info> list,IntPtr h,uint target,bool child) {
   uint pid; GetWindowThreadProcessId(h,out pid); if(pid!=target)return;
   var text=new StringBuilder(256); GetWindowText(h,text,text.Capacity); if(text.Length==0)return;
   Rect bounds,client; GetWindowRect(h,out bounds); GetClientRect(h,out client);
   var origin=new Point(); ClientToScreen(h,ref origin);
   client.Right+=origin.X; client.Bottom+=origin.Y; client.Left=origin.X; client.Top=origin.Y;
   uint color,flags; byte alpha; bool layered=GetLayeredWindowAttributes(h,out color,out alpha,out flags);
   var above=new List<long>(); var sibling=GetWindow(h,3);
   for(int count=0;sibling!=IntPtr.Zero && count<128;count++,sibling=GetWindow(sibling,3)) {
     Rect other; if(IsWindowVisible(sibling) && GetWindowRect(sibling,out other)
       && other.Left<bounds.Right && other.Right>bounds.Left && other.Top<bounds.Bottom && other.Bottom>bounds.Top) above.Add(sibling.ToInt64());
   }
   list.Add(new Info{Handle=h.ToInt64(),Parent=GetParent(h).ToInt64(),ProcessId=pid,Title=text.ToString(),Visible=IsWindowVisible(h),Child=child,Alpha=layered?alpha:-1,Bounds=bounds,Client=client,OccludingSiblings=above});
 }
 public static Info[] Read(uint target) {
   var list=new List<Info>(); EnumWindows((h,p)=> {
     Add(list,h,target,false); uint pid; GetWindowThreadProcessId(h,out pid);
     if(pid==target)EnumChildWindows(h,(c,a)=>{Add(list,c,target,true);return true;},IntPtr.Zero);
     return true;
   },IntPtr.Zero);return list.ToArray();
 }
}
'@
[void][WallpaperSettingWindows]::SetThreadDpiAwarenessContext([IntPtr](-4))
$taskWindows=@([WallpaperSettingWindows]::Read([uint32]$TargetPid))
if ($ScreenshotPath) {
    Add-Type -AssemblyName System.Drawing
    $taskMain=$taskWindows | Where-Object { $_.Title -eq 'HertzStudio Music Player' -and -not $_.Child } | Select-Object -First 1
    if (-not $taskMain) { throw 'Owned main window not found' }
    $taskRect=$taskMain.Client
    $taskBitmap=New-Object System.Drawing.Bitmap(($taskRect.Right-$taskRect.Left),($taskRect.Bottom-$taskRect.Top))
    $taskGraphics=[Drawing.Graphics]::FromImage($taskBitmap)
    try {
        $taskGraphics.CopyFromScreen($taskRect.Left,$taskRect.Top,0,0,$taskBitmap.Size)
        $taskBitmap.Save($ScreenshotPath,[Drawing.Imaging.ImageFormat]::Png)
    } finally { $taskGraphics.Dispose(); $taskBitmap.Dispose() }
}
ConvertTo-Json -Depth 5 -Compress -InputObject $taskWindows
