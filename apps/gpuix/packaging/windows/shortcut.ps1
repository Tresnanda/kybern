# Create a .lnk that carries an AppUserModelID (the id Windows groups the app's
# taskbar button and toast notifications under), or read one back with -Read.
# NSIS's CreateShortCut cannot set the property, so the installer calls this and
# falls back to a plain shortcut if it fails (for instance in Constrained
# Language Mode, where Add-Type is blocked).
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Target,
  [string]$WorkingDirectory,
  [string]$Icon,
  [string]$AppId,
  [string]$Description,
  [switch]$Read
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class KybernShortcut
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class CShellLink { }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    interface IShellLinkW
    {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PROPERTYKEY { public Guid fmtid; public uint pid; }

    // PROPVARIANT is 16 bytes on x86 and 24 on x64; claiming 24 is safe for both.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT
    {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr pointer;
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    interface IPropertyStore
    {
        void GetCount(out uint cProps);
        void GetAt(uint iProp, out PROPERTYKEY pkey);
        void GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
        void SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
        void Commit();
    }

    const ushort VT_LPWSTR = 31;

    // System.AppUserModel.ID: {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
    static PROPERTYKEY AppIdKey()
    {
        PROPERTYKEY key = new PROPERTYKEY();
        key.fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
        key.pid = 5;
        return key;
    }

    public static void Create(string path, string target, string workingDirectory, string icon, string appId, string description)
    {
        IShellLinkW link = (IShellLinkW)new CShellLink();
        link.SetPath(target);
        if (!String.IsNullOrEmpty(workingDirectory)) link.SetWorkingDirectory(workingDirectory);
        if (!String.IsNullOrEmpty(icon)) link.SetIconLocation(icon, 0);
        if (!String.IsNullOrEmpty(description)) link.SetDescription(description);
        if (!String.IsNullOrEmpty(appId))
        {
            IPropertyStore store = (IPropertyStore)link;
            PROPERTYKEY key = AppIdKey();
            PROPVARIANT value = new PROPVARIANT();
            value.vt = VT_LPWSTR;
            value.pointer = Marshal.StringToCoTaskMemUni(appId);
            try { store.SetValue(ref key, ref value); store.Commit(); }
            finally { Marshal.FreeCoTaskMem(value.pointer); }
        }
        ((IPersistFile)link).Save(path, true);
    }

    public static string ReadAppId(string path)
    {
        IShellLinkW link = (IShellLinkW)new CShellLink();
        ((IPersistFile)link).Load(path, 0);
        IPropertyStore store = (IPropertyStore)link;
        PROPERTYKEY key = AppIdKey();
        PROPVARIANT value;
        store.GetValue(ref key, out value);
        if (value.vt != VT_LPWSTR || value.pointer == IntPtr.Zero) return "";
        string id = Marshal.PtrToStringUni(value.pointer);
        Marshal.FreeCoTaskMem(value.pointer);
        return id;
    }
}
'@

if ($Read) {
  [KybernShortcut]::ReadAppId($Path)
} else {
  if (-not $Target) { throw 'Target is required' }
  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  [KybernShortcut]::Create($Path, $Target, $WorkingDirectory, $Icon, $AppId, $Description)
}
