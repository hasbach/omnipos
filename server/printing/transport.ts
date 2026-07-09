import net from "net";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { spawn } from "child_process";

export interface PrinterTarget {
  connection: 'usb' | 'network' | 'bluetooth';
  address: string;
  name: string;
}

// Sends raw bytes to a network (Ethernet/WiFi) printer over its RAW/JetDirect port (default 9100).
// Address may be "host" or "host:port".
function sendRawToNetworkPrinter(address: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    let host = address;
    let port = 9100;
    if (address.includes(':')) {
      const [h, p] = address.split(':');
      host = h;
      const parsed = parseInt(p, 10);
      if (!isNaN(parsed)) port = parsed;
    }

    const socket = new net.Socket();
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (err) reject(err); else resolve();
    };

    const timeout = setTimeout(() => done(new Error(`Timed out connecting to printer at ${host}:${port}`)), 8000);

    socket.on('error', (err) => done(err));
    socket.connect(port, host, () => {
      socket.write(data, (err) => {
        if (err) return done(err);
        done();
      });
    });
  });
}

// Windows-only: sends raw bytes directly to an installed printer's spooler queue by name,
// bypassing GDI text translation. This is the standard approach for driving ESC/POS
// thermal printers that are installed as a normal Windows printer (USB, or Bluetooth
// paired as a printer queue), using the well-known WritePrinter() Win32 API via a small
// embedded PowerShell/C# helper (no native Node module / build step required).
const RAW_PRINT_PS1 = `
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$DataPath
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public class OmniPosRawPrint {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
    public class DOCINFOA {
        [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
    }

    [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

    [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool ClosePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);

    [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool EndDocPrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool StartPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool EndPagePrinter(IntPtr hPrinter);

    [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true, ExactSpelling=true, CallingConvention=CallingConvention.StdCall)]
    public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

    public static bool SendBytesToPrinter(string szPrinterName, byte[] bytes) {
        IntPtr hPrinter;
        DOCINFOA di = new DOCINFOA();
        di.pDocName = "OmniPOS Receipt";
        di.pDataType = "RAW";
        bool success = false;

        if (OpenPrinter(szPrinterName, out hPrinter, IntPtr.Zero)) {
            if (StartDocPrinter(hPrinter, 1, di)) {
                if (StartPagePrinter(hPrinter)) {
                    IntPtr pUnmanagedBytes = Marshal.AllocCoTaskMem(bytes.Length);
                    Marshal.Copy(bytes, 0, pUnmanagedBytes, bytes.Length);
                    int dwWritten;
                    success = WritePrinter(hPrinter, pUnmanagedBytes, bytes.Length, out dwWritten);
                    Marshal.FreeCoTaskMem(pUnmanagedBytes);
                    EndPagePrinter(hPrinter);
                }
                EndDocPrinter(hPrinter);
            }
            ClosePrinter(hPrinter);
        }
        return success;
    }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($DataPath)
$ok = [OmniPosRawPrint]::SendBytesToPrinter($PrinterName, $bytes)
if (-not $ok) {
  $errCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error "Failed to send data to printer '$PrinterName' (Win32 error $errCode). Check the printer name matches exactly what's shown in Windows > Printers & Scanners, and that the printer is online."
  exit 1
}
Write-Output "OK"
`;

function sendRawToWindowsPrinter(printerName: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      return reject(new Error("USB/direct printer names are only supported on Windows in this build."));
    }

    const tmpDir = os.tmpdir();
    const id = crypto.randomBytes(6).toString('hex');
    const dataPath = path.join(tmpDir, `omnipos-print-${id}.bin`);
    const scriptPath = path.join(tmpDir, `omnipos-print-${id}.ps1`);

    const cleanup = () => {
      try { fs.unlinkSync(dataPath); } catch {}
      try { fs.unlinkSync(scriptPath); } catch {}
    };

    try {
      fs.writeFileSync(dataPath, data);
      fs.writeFileSync(scriptPath, RAW_PRINT_PS1, 'utf8');
    } catch (err: any) {
      cleanup();
      return reject(err);
    }

    const proc = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-PrinterName', printerName,
      '-DataPath', dataPath
    ]);

    let stderr = '';
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(safety);
      cleanup();
      if (err) reject(err); else resolve();
    };

    const safety = setTimeout(() => {
      try { proc.kill(); } catch {}
      finish(new Error("Timed out sending data to the printer."));
    }, 15000);

    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `Print helper exited with code ${code}`));
    });
  });
}

export async function sendToPrinter(printer: PrinterTarget, data: Buffer): Promise<void> {
  if (printer.connection === 'network') {
    if (!printer.address) throw new Error("This printer has no IP address configured.");
    return sendRawToNetworkPrinter(printer.address, data);
  }

  if (printer.connection === 'usb') {
    if (!printer.address) throw new Error("This printer has no Windows printer name configured.");
    return sendRawToWindowsPrinter(printer.address, data);
  }

  if (printer.connection === 'bluetooth') {
    throw new Error("Direct Bluetooth printing isn't supported yet — pair the printer as a Windows printer and add it as a USB/direct printer using its Windows printer name instead.");
  }

  throw new Error(`Unsupported printer connection type: ${printer.connection}`);
}
