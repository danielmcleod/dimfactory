# Sets the CI runner's primary screen to 1920 x 1080 before the Windows E2E suite.
#
# GitHub's Windows runners start at 1024 x 768, smaller than the app's own window (1280 x 840) and the game preview
# (1100 x 780 content). Windows then shrinks those windows to the screen, so the Run view lays Review and Critic out
# for a narrow window and the preview's size is not the one the app asked for. The Linux smoke job gets the same room
# from xvfb-run's 1280 x 800 screen. Fails when the size cannot be set, so a too-small screen never reads as a product
# failure later.
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CiScreen {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public short dmSpecVersion;
    public short dmDriverVersion;
    public short dmSize;
    public short dmDriverExtra;
    public int dmFields;
    public int dmPositionX;
    public int dmPositionY;
    public int dmDisplayOrientation;
    public int dmDisplayFixedOutput;
    public short dmColor;
    public short dmDuplex;
    public short dmYResolution;
    public short dmTTOption;
    public short dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public short dmLogPixels;
    public int dmBitsPerPel;
    public int dmPelsWidth;
    public int dmPelsHeight;
    public int dmDisplayFlags;
    public int dmDisplayFrequency;
    public int dmICMMethod;
    public int dmICMIntent;
    public int dmMediaType;
    public int dmDitherType;
    public int dmReserved1;
    public int dmReserved2;
    public int dmPanningWidth;
    public int dmPanningHeight;
  }

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref DEVMODE devMode);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int ChangeDisplaySettings(ref DEVMODE devMode, int flags);

  const int ENUM_CURRENT_SETTINGS = -1;
  const int DM_PELSWIDTH = 0x80000;
  const int DM_PELSHEIGHT = 0x100000;
  const int CDS_UPDATEREGISTRY = 0x01;

  public static string Current() {
    DEVMODE dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref dm);
    return dm.dmPelsWidth + " x " + dm.dmPelsHeight;
  }

  // 0 when the size was set (DISP_CHANGE_SUCCESSFUL), else the DISP_CHANGE code.
  public static int Set(int width, int height) {
    DEVMODE dm = new DEVMODE();
    dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettings(null, ENUM_CURRENT_SETTINGS, ref dm)) return -100;
    dm.dmPelsWidth = width;
    dm.dmPelsHeight = height;
    dm.dmFields = DM_PELSWIDTH | DM_PELSHEIGHT;
    return ChangeDisplaySettings(ref dm, CDS_UPDATEREGISTRY);
  }
}
'@

Write-Output "Screen before: $([CiScreen]::Current())"
$code = [CiScreen]::Set(1920, 1080)
$now = [CiScreen]::Current()
Write-Output "Screen after: $now (ChangeDisplaySettings returned $code)"
if ($now -ne '1920 x 1080') { throw "The screen is $now, not 1920 x 1080" }
