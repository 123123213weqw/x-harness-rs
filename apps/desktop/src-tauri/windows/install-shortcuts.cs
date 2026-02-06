// Unicode Shell Link API. WScript.Shell.TargetPath can reject non-ANSI paths
// on machines whose system locale differs from the installation path language.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace XHarnessInstaller {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, IntPtr data, uint flags);
        void GetIDList(out IntPtr value);
        void SetIDList(IntPtr value);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string value);
        void GetHotkey(out short value);
        void SetHotkey(short value);
        void GetShowCmd(out int value);
        void SetShowCmd(int value);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder value, int count, out int index);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string value, int index);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string value, uint reserved);
        void Resolve(IntPtr window, uint flags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string value);
    }
    public sealed class ShortcutInfo {
        public string TargetPath { get; set; }
        public string Arguments { get; set; }
    }
    public static class Shortcuts {
        static IShellLinkW Create() {
            return (IShellLinkW)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        }
        public static ShortcutInfo Read(string path) {
            IShellLinkW link = Create();
            try {
                ((IPersistFile)link).Load(path, 0);
                var target = new StringBuilder(32768);
                var arguments = new StringBuilder(32768);
                link.GetPath(target, target.Capacity, IntPtr.Zero, 4);
                link.GetArguments(arguments, arguments.Capacity);
                return new ShortcutInfo { TargetPath = target.ToString(), Arguments = arguments.ToString() };
            } finally { Marshal.FinalReleaseComObject(link); }
        }
        public static void Update(string path, string target, string directory) {
            IShellLinkW link = Create();
            try {
                if (File.Exists(path)) ((IPersistFile)link).Load(path, 0);
                link.SetPath(target);
                link.SetWorkingDirectory(directory);
                link.SetIconLocation(target, 0);
                ((IPersistFile)link).Save(path, true);
            } finally { Marshal.FinalReleaseComObject(link); }
        }
    }
}
