param([int]$ServerPort = 0)
# ydesk input helper for Windows: reads commands on stdin, injects with SendInput.

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;

public static class YSend
{
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT
    {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    const int INPUT_MOUSE = 0;
    const int INPUT_KEYBOARD = 1;
    const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004;
    const uint RIGHTDOWN = 0x0008, RIGHTUP = 0x0010, MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
    const uint WHEEL = 0x0800, HWHEEL = 0x1000, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    const uint KEYUP = 0x0002, UNICODE = 0x0004;

    static void Send(INPUT input)
    {
        INPUT[] buffer = new INPUT[1];
        buffer[0] = input;
        SendInput(1, buffer, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void Move(double nx, double ny)
    {
        int w = GetSystemMetrics(78), h = GetSystemMetrics(79);
        if (w <= 0) w = GetSystemMetrics(0);
        if (h <= 0) h = GetSystemMetrics(1);
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dx = (int)Math.Round(Math.Max(0.0, Math.Min(1.0, nx)) * 65535.0);
        input.u.mi.dy = (int)Math.Round(Math.Max(0.0, Math.Min(1.0, ny)) * 65535.0);
        input.u.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK;
        Send(input);
    }

    public static void Button(int button, bool down)
    {
        uint flag = button == 2 ? (down ? RIGHTDOWN : RIGHTUP)
                 : button == 3 ? (down ? MIDDLEDOWN : MIDDLEUP)
                 : (down ? LEFTDOWN : LEFTUP);
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.dwFlags = flag;
        Send(input);
    }

    public static void Wheel(int lines, int horizontal)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.u.mi.mouseData = unchecked((uint)(lines * 120));
        input.u.mi.dwFlags = horizontal != 0 ? HWHEEL : WHEEL;
        Send(input);
    }

    public static void Key(int vk, bool down)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.u.ki.wVk = (ushort)vk;
        input.u.ki.dwFlags = down ? 0u : KEYUP;
        if (vk == 0x2E || vk == 0x24 || vk == 0x23 || vk == 0x21 || vk == 0x22 || vk == 0x2D)
        {
            input.u.ki.dwFlags |= 0x0001;
        }
        Send(input);
    }

    public static void Text(string value)
    {
        foreach (char ch in value)
        {
            INPUT down = new INPUT();
            down.type = INPUT_KEYBOARD;
            down.u.ki.wScan = (ushort)ch;
            down.u.ki.dwFlags = UNICODE;
            Send(down);
            INPUT up = new INPUT();
            up.type = INPUT_KEYBOARD;
            up.u.ki.wScan = (ushort)ch;
            up.u.ki.dwFlags = UNICODE | KEYUP;
            Send(up);
        }
    }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp | Out-Null
} catch {
  [Console]::Out.WriteLine("ERR Add-Type failed: $($_.Exception.Message)")
  exit 1
}

function Send-Line([string]$text) {
  try {
    $script:writer.WriteLine($text)
    $script:writer.Flush()
  } catch {}
}

function Handle-Line([string]$line) {
  $line = $line.Trim()
  if ($env:YDESK_INPUT_LOG) {
    try { Add-Content -Path $env:YDESK_INPUT_LOG -Value ("{0} {1}" -f (Get-Date -Format "HH:mm:ss.fff"), $line) } catch {}
  }
  if ($line.Length -eq 0) { return }
  $parts = $line.Split(' ')
  try {
    switch ($parts[0]) {
      'm' { [YSend]::Move([double]$parts[1], [double]$parts[2]) }
      'md' { [YSend]::Button([int]$parts[1], $true) }
      'mu' { [YSend]::Button([int]$parts[1], $false) }
      'w' {
        $h = 0
        if ($parts.Length -gt 2) { $h = [int][double]$parts[2] }
        [YSend]::Wheel([int][double]$parts[1], $h)
      }
      'kd' { [YSend]::Key([int]$parts[1], $true) }
      'ku' { [YSend]::Key([int]$parts[1], $false) }
      't' {
        $bytes = [Convert]::FromBase64String($parts[1])
        [YSend]::Text([Text.Encoding]::UTF8.GetString($bytes))
      }
      'size' {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        Send-Line "SIZE $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width) $([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height)"
      }
    }
  } catch {
    Send-Line "ERR $($_.Exception.Message)"
  }
}

if ($ServerPort -gt 0) {
  # Session 0 has no interactive desktop: the Host schedules this helper into
  # the user's own session and drives it over a loopback socket.
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $ServerPort)
  $listener.Start()
  while ($true) {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $script:reader = New-Object System.IO.StreamReader($stream)
    $script:writer = New-Object System.IO.StreamWriter($stream)
    $script:writer.AutoFlush = $true
    Send-Line 'READY'
    while ($true) {
      $next = $script:reader.ReadLine()
      if ($null -eq $next) { break }
      Handle-Line $next
    }
    try { $client.Close() } catch {}
  }
} else {
  $script:reader = [Console]::In
  $script:writer = [Console]::Out
  Send-Line 'READY'
  while ($true) {
    $next = $script:reader.ReadLine()
    if ($null -eq $next) { break }
    Handle-Line $next
  }
}
