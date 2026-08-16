// ============================================================================
// Full Browser Extension for VS Code / Antigravity IDE
// Uses Puppeteer + Chrome DevTools Protocol (CDP) Screencast
// to stream a real Chromium browser inside a VS Code Webview panel.
// ============================================================================

const vscode = require('vscode');
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

// ---------------------------------------------------------------------------
// Global State
// ---------------------------------------------------------------------------
let browser = null;
let mainPage = null;
let activePage = null;
let page = null;          // Alias for activePage
let pageStack = [];
let cdpSession = null;
let panel = null;
let currentScreencastWidth = 1280;
let currentScreencastHeight = 800;
let currentLogicalWidth = 1280;
let currentLogicalHeight = 800;
let currentDpr = 1;
let currentZoom = 1.0;
let currentUserDataDir = null;    // Track for runtime cookie re-sync
let currentProfileMode = null;    // Track for runtime cookie re-sync

// ============================================================================
// ACTIVATION
// ============================================================================
function activate(context) {
    // Status Bar Item (Visible at bottom-right of VS Code)
    const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = 'fullBrowser.open';
    statusBarItem.text = '$(globe) ChromeX';
    statusBarItem.tooltip = 'Click to open ChromeX Browser';
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // Command: Open Full Browser
    const openCmd = vscode.commands.registerCommand('fullBrowser.open', async () => {
        await openBrowser(context);
    });

    // Command: Open URL in Full Browser
    const openUrlCmd = vscode.commands.registerCommand('fullBrowser.openUrl', async () => {
        const url = await vscode.window.showInputBox({
            prompt: 'Enter URL to open',
            placeHolder: 'https://example.com',
            validateInput: (value) => {
                if (!value) return 'URL is required';
                return undefined;
            }
        });
        if (url) {
            await openBrowser(context, url);
        }
    });

    context.subscriptions.push(openCmd, openUrlCmd);
}

// ============================================================================
// FIND CHROME / EDGE / BRAVE ON THE SYSTEM
// ============================================================================
function findChromePath() {
    const config = vscode.workspace.getConfiguration('fullBrowser');
    const userPath = config.get('chromePath', '');
    if (userPath && fs.existsSync(userPath)) {
        return userPath;
    }

    const possiblePaths = [];

    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
        const pfx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

        possiblePaths.push(
            // Chrome
            path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pfx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            // Edge
            path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(pfx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            // Brave
            path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(pfx86, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
            path.join(local, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
        );
    } else if (process.platform === 'darwin') {
        possiblePaths.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
            '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        );
    } else {
        possiblePaths.push(
            '/usr/bin/google-chrome',
            '/usr/bin/google-chrome-stable',
            '/usr/bin/chromium-browser',
            '/usr/bin/chromium',
            '/usr/bin/microsoft-edge',
        );
    }

    for (const p of possiblePaths) {
        try {
            if (fs.existsSync(p)) return p;
        } catch { /* skip */ }
    }
    return null;
}

// ---------------------------------------------------------------------------
// CHROME PROFILE AUTO-DETECTION
// ---------------------------------------------------------------------------
function getActiveChromeProfile(chromeProfileDir, configuredProfile) {
    if (configuredProfile && configuredProfile !== 'auto') {
        return configuredProfile;
    }
    try {
        const localStatePath = path.join(chromeProfileDir, 'Local State');
        if (fs.existsSync(localStatePath)) {
            const raw = fs.readFileSync(localStatePath, 'utf8');
            const json = JSON.parse(raw);
            const infoCache = json.profile && json.profile.info_cache;
            if (infoCache) {
                let bestProfile = 'Default';
                let maxActiveTime = 0;
                for (const [profKey, profData] of Object.entries(infoCache)) {
                    const activeTime = profData.active_time || 0;
                    if (activeTime > maxActiveTime) {
                        maxActiveTime = activeTime;
                        bestProfile = profKey;
                    }
                }
                return bestProfile;
            }
        }
    } catch {}
    return 'Default';
}

// ---------------------------------------------------------------------------
// OPEN URL IN USER'S REAL CHROME (with their logged-in profile)
// ---------------------------------------------------------------------------
function openInUserChrome(url) {
    const config = vscode.workspace.getConfiguration('fullBrowser');
    const configuredProfile = config.get('profileDirectory', 'auto');

    // Find Chrome executable
    const chromePath = findChromePath();

    // Determine Chrome User Data Dir and profile
    const chromeUserDataDir = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
        : process.platform === 'darwin'
            ? path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome')
            : path.join(process.env.HOME || '', '.config', 'google-chrome');

    const profileDir = getActiveChromeProfile(chromeUserDataDir, configuredProfile);

    if (chromePath && fs.existsSync(chromeUserDataDir)) {
        // Launch Chrome with the user's real profile directory
        const cmd = `"${chromePath}" --profile-directory="${profileDir}" "${url}"`;
        exec(cmd, (err) => {
            if (err) {
                // Fallback to OS default
                vscode.env.openExternal(vscode.Uri.parse(url));
            }
        });
    } else {
        // Fallback to OS default
        vscode.env.openExternal(vscode.Uri.parse(url));
    }
}

// ---------------------------------------------------------------------------
// COPY LOCKED FILE (handles Chrome's locked SQLite databases)
// ---------------------------------------------------------------------------
function copyLockedFile(src, dst) {
    // Ensure destination directory exists
    try { fs.mkdirSync(path.dirname(dst), { recursive: true }); } catch {}

    // Method 1: Direct fs copy
    try {
        fs.copyFileSync(src, dst);
        return true;
    } catch {}

    // Method 2: PowerShell with .NET FileShare.ReadWrite (bypasses SQLite locks)
    if (process.platform === 'win32') {
        try {
            const scriptPath = path.join(require('os').tmpdir(), `copy_locked_${Date.now()}.ps1`);
            const script = `
$src = '${src.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$dst = '${dst.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$dstDir = [System.IO.Path]::GetDirectoryName($dst)
if (!(Test-Path $dstDir)) { [void](New-Item -ItemType Directory -Path $dstDir -Force) }
$inStream = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
$buf = New-Object byte[] $inStream.Length
[void]$inStream.Read($buf, 0, $buf.Length)
$inStream.Close()
[System.IO.File]::WriteAllBytes($dst, $buf)
`;
            fs.writeFileSync(scriptPath, script, 'utf8');
            require('child_process').execSync(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
                { timeout: 10000, stdio: 'ignore' }
            );
            try { fs.unlinkSync(scriptPath); } catch {}
            return true;
        } catch {}
    }

    return false;
}

// ---------------------------------------------------------------------------
// SYNC CHROME COOKIES TO PUPPETEER PROFILE
// Copies session cookies from Chrome's real profile to the extension's
// persistent profile so the in-app browser is already logged in.
// ---------------------------------------------------------------------------
function syncChromeCookies(destUserDataDir) {
    if (process.platform !== 'win32') return; // Windows only for now

    const chromeUserDataDir = path.join(
        process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'
    );
    if (!fs.existsSync(chromeUserDataDir)) return;

    const config = vscode.workspace.getConfiguration('fullBrowser');
    const profileName = getActiveChromeProfile(
        chromeUserDataDir, config.get('profileDirectory', 'auto')
    );
    const sourceProfile = path.join(chromeUserDataDir, profileName);
    if (!fs.existsSync(sourceProfile)) return;

    // Puppeteer uses "Default" profile inside its userDataDir
    const destDefault = path.join(destUserDataDir, 'Default');

    // Critical files to copy for session persistence
    const filesToSync = [
        // Local State contains the cookie encryption key (DPAPI-wrapped)
        {
            src: path.join(chromeUserDataDir, 'Local State'),
            dst: path.join(destUserDataDir, 'Local State'),
        },
        // Cookies database
        {
            src: path.join(sourceProfile, 'Network', 'Cookies'),
            dst: path.join(destDefault, 'Network', 'Cookies'),
        },
        {
            src: path.join(sourceProfile, 'Network', 'Cookies-journal'),
            dst: path.join(destDefault, 'Network', 'Cookies-journal'),
        },
        // Local Storage (some sites use this for auth tokens)
        {
            src: path.join(sourceProfile, 'Local Storage', 'leveldb'),
            dst: path.join(destDefault, 'Local Storage', 'leveldb'),
            isDir: true,
        },
    ];

    let copied = 0;
    for (const item of filesToSync) {
        if (!fs.existsSync(item.src)) continue;

        if (item.isDir) {
            // Copy directory contents
            try {
                fs.mkdirSync(item.dst, { recursive: true });
                const files = fs.readdirSync(item.src);
                for (const f of files) {
                    const srcFile = path.join(item.src, f);
                    const dstFile = path.join(item.dst, f);
                    if (fs.statSync(srcFile).isFile()) {
                        if (copyLockedFile(srcFile, dstFile)) copied++;
                    }
                }
            } catch {}
        } else {
            if (copyLockedFile(item.src, item.dst)) copied++;
        }
    }

    if (copied > 0) {
        console.log(`[Full Browser] Synced ${copied} files from Chrome ${profileName}`);
    }
}

// ---------------------------------------------------------------------------
// RUNTIME COOKIE SYNC VIA CDP
// Reads cookies from Chrome's real profile and injects them into the running
// Puppeteer browser via CDP. Works while both browsers are running.
// ---------------------------------------------------------------------------
async function syncCookiesViaCDP() {
    if (!activePage || !cdpSession || !panel) return;

    const currentUrl = activePage.url();
    let domain;
    try {
        domain = new URL(currentUrl).hostname;
    } catch {
        vscode.window.showWarningMessage('Cannot sync: invalid current URL.');
        return;
    }

    panel.webview.postMessage({ type: 'status', message: 'Syncing session from Chrome...' });

    try {
        // Determine Chrome's real cookies DB path
        const chromeUserDataDir = process.platform === 'win32'
            ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
            : process.platform === 'darwin'
                ? path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome')
                : path.join(process.env.HOME || '', '.config', 'google-chrome');

        const config = vscode.workspace.getConfiguration('fullBrowser');
        const profileName = getActiveChromeProfile(
            chromeUserDataDir, config.get('profileDirectory', 'auto')
        );

        const cookiesDbPath = path.join(chromeUserDataDir, profileName, 'Network', 'Cookies');
        if (!fs.existsSync(cookiesDbPath)) {
            // Try alternate location (older Chrome versions)
            const altPath = path.join(chromeUserDataDir, profileName, 'Cookies');
            if (!fs.existsSync(altPath)) {
                vscode.window.showWarningMessage('Chrome cookies database not found.');
                return;
            }
        }

        // Extract the base domain for matching (e.g., ".takeuforward.org" from "www.takeuforward.org")
        const domainParts = domain.split('.');
        const baseDomain = domainParts.length >= 2
            ? domainParts.slice(-2).join('.')
            : domain;

        // Use PowerShell to read cookies from Chrome's locked SQLite DB
        // Chrome encrypts cookie values with DPAPI on Windows, so we use
        // a PowerShell script that decrypts them
        const cookiesJson = await extractCookiesViaPowerShell(cookiesDbPath, baseDomain, chromeUserDataDir);

        if (!cookiesJson || cookiesJson.length === 0) {
            // Fallback: just do file-level sync and restart
            if (currentUserDataDir && currentProfileMode === 'persistent') {
                try { syncChromeCookies(currentUserDataDir); } catch {}
            }
            // Reload the page to pick up file-synced cookies
            await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            panel.webview.postMessage({ type: 'status', message: 'Session synced (file mode)' });
            vscode.window.showInformationMessage('🔄 Session synced. Page reloaded.');
            return;
        }

        // Inject cookies via CDP
        let injected = 0;
        for (const cookie of cookiesJson) {
            try {
                await cdpSession.send('Network.setCookie', {
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path || '/',
                    secure: cookie.secure || false,
                    httpOnly: cookie.httpOnly || false,
                    sameSite: cookie.sameSite || 'Lax',
                    expires: cookie.expires || -1,
                });
                injected++;
            } catch {}
        }

        console.log(`[Full Browser] Injected ${injected}/${cookiesJson.length} cookies for ${baseDomain}`);

        // Also sync localStorage if possible
        await syncLocalStorageViaCDP(baseDomain);

        // Reload the page to apply the new cookies
        await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

        panel.webview.postMessage({ type: 'status', message: `Synced ${injected} cookies` });
        vscode.window.showInformationMessage(`✅ Session synced! ${injected} cookies imported. Page reloaded.`);

    } catch (err) {
        console.error('[Full Browser] Cookie sync error:', err);
        // Fallback: file-level sync + reload
        if (currentUserDataDir && currentProfileMode === 'persistent') {
            try { syncChromeCookies(currentUserDataDir); } catch {}
        }
        await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        panel.webview.postMessage({ type: 'status', message: 'Session synced (fallback)' });
        vscode.window.showInformationMessage('🔄 Session synced (fallback mode). Page reloaded.');
    }
}

// ---------------------------------------------------------------------------
// EXTRACT COOKIES FROM CHROME'S SQLITE DB VIA POWERSHELL
// Handles Chrome's DPAPI encryption (Windows) and file locking.
// ---------------------------------------------------------------------------
function extractCookiesViaPowerShell(cookiesDbPath, baseDomain, chromeUserDataDir) {
    return new Promise((resolve) => {
        if (process.platform !== 'win32') {
            resolve([]);
            return;
        }

        const tempDbPath = path.join(require('os').tmpdir(), `chrome_cookies_${Date.now()}.db`);
        const outputPath = path.join(require('os').tmpdir(), `cookies_out_${Date.now()}.json`);

        // PowerShell script that:
        // 1. Copies the locked Cookies DB using FileShare.ReadWrite
        // 2. Reads cookies matching the domain using System.Data.SQLite or direct SQLite
        // 3. Decrypts cookie values using DPAPI (Chrome's AES-GCM with Local State key)
        // 4. Outputs as JSON
        const ps1 = `
$ErrorActionPreference = 'SilentlyContinue'

# 1. Copy locked Cookies DB
$src = '${cookiesDbPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$tmp = '${tempDbPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$out = '${outputPath.replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$localStatePath = '${path.join(chromeUserDataDir, 'Local State').replace(/\\/g, '\\\\').replace(/'/g, "''")}'
$domain = '${baseDomain.replace(/'/g, "''")}'

try {
    $inStream = [System.IO.File]::Open($src, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))
    $buf = New-Object byte[] $inStream.Length
    [void]$inStream.Read($buf, 0, $buf.Length)
    $inStream.Close()
    [System.IO.File]::WriteAllBytes($tmp, $buf)
} catch {
    '[]' | Set-Content $out -Encoding UTF8
    exit
}

# 2. Get the AES key from Local State (Chrome v80+)
$aesKey = $null
try {
    $localState = Get-Content $localStatePath -Raw | ConvertFrom-Json
    $encKeyB64 = $localState.os_crypt.encrypted_key
    $encKeyBytes = [Convert]::FromBase64String($encKeyB64)
    # Remove "DPAPI" prefix (5 bytes)
    $dpapiBlob = $encKeyBytes[5..($encKeyBytes.Length - 1)]
    Add-Type -AssemblyName System.Security
    $aesKey = [System.Security.Cryptography.ProtectedData]::Unprotect($dpapiBlob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
} catch {}

# 3. SQLite query - use System.Data.SQLite if available, otherwise ADO.NET with ODBC
$cookies = @()
try {
    Add-Type -Path "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\*\\System.Data.SQLite.dll" 2>$null
} catch {}

$connStr = "Data Source=$tmp;Version=3;Read Only=True;"
$conn = $null
try {
    [System.Reflection.Assembly]::LoadWithPartialName('System.Data.SQLite') | Out-Null
    $conn = New-Object System.Data.SQLite.SQLiteConnection($connStr)
} catch {
    # Fallback: try loading from NuGet or bundled
    try {
        $sqliteDll = Get-ChildItem "$env:USERPROFILE\\.nuget\\packages\\system.data.sqlite*\\**\\System.Data.SQLite.dll" -Recurse | Select-Object -First 1
        if ($sqliteDll) {
            Add-Type -Path $sqliteDll.FullName
            $conn = New-Object System.Data.SQLite.SQLiteConnection($connStr)
        }
    } catch {}
}

if (-not $conn) {
    # Ultimate fallback: use sqlite3.exe if available
    $sqlite3 = Get-Command sqlite3.exe -ErrorAction SilentlyContinue
    if ($sqlite3) {
        $query = "SELECT name, host_key, path, is_secure, is_httponly, expires_utc, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%$domain%';"
        $rawOutput = & sqlite3.exe $tmp $query 2>$null
        if ($rawOutput) {
            foreach ($line in $rawOutput) {
                $parts = $line -split '\\|'
                if ($parts.Count -ge 4) {
                    $cookies += @{
                        name = $parts[0]
                        domain = $parts[1]
                        path = $parts[2]
                        secure = ($parts[3] -eq '1')
                        httpOnly = ($parts[4] -eq '1')
                        value = ''  # Can't easily decrypt without proper code
                    }
                }
            }
        }
    }
    $cookies | ConvertTo-Json -Depth 3 | Set-Content $out -Encoding UTF8
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    exit
}

try {
    $conn.Open()
    $cmd = $conn.CreateCommand()
    $cmd.CommandText = "SELECT name, encrypted_value, host_key, path, is_secure, is_httponly, expires_utc, samesite FROM cookies WHERE host_key LIKE '%$domain%'"
    $reader = $cmd.ExecuteReader()

    while ($reader.Read()) {
        $name = $reader['name']
        $encValue = [byte[]]$reader['encrypted_value']
        $hostKey = $reader['host_key']
        $cookiePath = $reader['path']
        $isSecure = [int]$reader['is_secure'] -eq 1
        $isHttpOnly = [int]$reader['is_httponly'] -eq 1
        $expiresUtc = [long]$reader['expires_utc']
        $sameSite = [int]$reader['samesite']

        # Decrypt cookie value
        $value = ''
        if ($encValue -and $encValue.Length -gt 0) {
            if ($aesKey -and $encValue.Length -gt 15 -and [System.Text.Encoding]::ASCII.GetString($encValue[0..2]) -eq 'v10') {
                # Chrome v80+ AES-256-GCM encryption
                try {
                    $nonce = $encValue[3..14]
                    $ciphertext = $encValue[15..($encValue.Length - 17)]
                    $tag = $encValue[($encValue.Length - 16)..($encValue.Length - 1)]
                    $aesGcm = [System.Security.Cryptography.AesGcm]::new($aesKey)
                    $plaintext = New-Object byte[] $ciphertext.Length
                    $aesGcm.Decrypt($nonce, $ciphertext, $tag, $plaintext)
                    $value = [System.Text.Encoding]::UTF8.GetString($plaintext)
                    $aesGcm.Dispose()
                } catch {
                    # Fallback to DPAPI
                    try {
                        Add-Type -AssemblyName System.Security
                        $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encValue, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
                        $value = [System.Text.Encoding]::UTF8.GetString($decrypted)
                    } catch {}
                }
            } else {
                # Legacy DPAPI encryption
                try {
                    Add-Type -AssemblyName System.Security
                    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($encValue, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
                    $value = [System.Text.Encoding]::UTF8.GetString($decrypted)
                } catch {}
            }
        }

        # Convert Chrome timestamp (microseconds since 1601-01-01) to Unix epoch
        $unixExpires = -1
        if ($expiresUtc -gt 0) {
            $unixExpires = [math]::Floor(($expiresUtc / 1000000) - 11644473600)
        }

        $sameSiteStr = switch ($sameSite) { 0 { 'None' } 1 { 'Lax' } 2 { 'Strict' } default { 'Lax' } }

        if ($value) {
            $cookies += @{
                name = $name
                value = $value
                domain = $hostKey
                path = $cookiePath
                secure = $isSecure
                httpOnly = $isHttpOnly
                expires = $unixExpires
                sameSite = $sameSiteStr
            }
        }
    }
    $reader.Close()
    $conn.Close()
} catch {} finally {
    if ($conn) { $conn.Dispose() }
}

$cookies | ConvertTo-Json -Depth 3 | Set-Content $out -Encoding UTF8
Remove-Item $tmp -Force -ErrorAction SilentlyContinue
`;

        const scriptPath = path.join(require('os').tmpdir(), `sync_cookies_${Date.now()}.ps1`);
        fs.writeFileSync(scriptPath, ps1, 'utf8');

        const { execSync } = require('child_process');
        try {
            execSync(
                `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
                { timeout: 15000, stdio: 'ignore' }
            );
        } catch {}

        let cookies = [];
        try {
            if (fs.existsSync(outputPath)) {
                const raw = fs.readFileSync(outputPath, 'utf8').trim();
                if (raw && raw !== '[]' && raw !== 'null') {
                    cookies = JSON.parse(raw);
                    if (!Array.isArray(cookies)) cookies = [cookies];
                }
            }
        } catch {}

        // Cleanup temp files
        try { fs.unlinkSync(scriptPath); } catch {}
        try { fs.unlinkSync(outputPath); } catch {}
        try { fs.unlinkSync(tempDbPath); } catch {}

        resolve(cookies);
    });
}

// ---------------------------------------------------------------------------
// SYNC LOCAL STORAGE FROM CHROME (best-effort)
// ---------------------------------------------------------------------------
async function syncLocalStorageViaCDP(baseDomain) {
    if (!activePage || !cdpSession) return;

    const chromeUserDataDir = process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
        : '';
    if (!chromeUserDataDir) return;

    const config = vscode.workspace.getConfiguration('fullBrowser');
    const profileName = getActiveChromeProfile(
        chromeUserDataDir, config.get('profileDirectory', 'auto')
    );

    const ldbDir = path.join(chromeUserDataDir, profileName, 'Local Storage', 'leveldb');
    if (!fs.existsSync(ldbDir)) return;

    // LevelDB parsing is complex; for localStorage sync, the cookie injection
    // + page reload is usually sufficient. Most modern auth uses cookies or
    // httpOnly cookies that are already handled above.
    // This is a placeholder for future enhancement.
}

// ============================================================================
// GENERATE WEBVIEW HTML
// ============================================================================
function getWebviewHtml(webview, extensionPath) {
    const mediaUri = (file) =>
        webview.asWebviewUri(vscode.Uri.file(path.join(extensionPath, 'media', file)));

    const cssUri = mediaUri('browser.css');
    const jsUri = mediaUri('browser.js');
    const nonce = crypto.randomBytes(16).toString('hex');
    const csp = webview.cspSource;

    const config = vscode.workspace.getConfiguration('fullBrowser');
    const homepage = config.get('homepage', 'https://www.google.com');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy"
          content="default-src 'none';
                   style-src ${csp} 'unsafe-inline';
                   script-src 'nonce-${nonce}';
                   img-src data: blob: ${csp};
                   font-src ${csp};">
    <link rel="stylesheet" href="${cssUri}">
    <title>Full Browser</title>
</head>
<body>
    <!-- ===== TOOLBAR ===== -->
    <div class="toolbar" id="toolbar">
        <div class="nav-group">
            <button class="nav-btn" id="btn-back" title="Back (Alt+Left)" disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M7 3L2 8l5 5v-3h6V6H7V3z"/>
                </svg>
            </button>
            <button class="nav-btn" id="btn-forward" title="Forward (Alt+Right)" disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9 3l5 5-5 5v-3H3V6h6V3z"/>
                </svg>
            </button>
            <button class="nav-btn" id="btn-reload" title="Reload (F5)">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M13.5 2.5l-1 1A5.98 5.98 0 008 2a6 6 0 106 6h-2a4 4 0 11-4-4c1.18 0 2.26.51 3 1.33l-1.5 1.5H14V2.5h-.5z"/>
                </svg>
            </button>
            <button class="nav-btn" id="btn-home" title="Home">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 1L1 7h2v6h4V9h2v4h4V7h2L8 1z"/>
                </svg>
            </button>
        </div>

        <div class="url-bar-wrapper">
            <div class="url-bar" id="url-bar">
                <span class="secure-icon" id="secure-icon" title="Connection Security">🔒</span>
                <input type="text"
                       id="url-input"
                       placeholder="Search Google or enter URL..."
                       value="${homepage}"
                       spellcheck="false"
                       autocomplete="off" />
                <button class="url-clear-btn hidden" id="btn-url-clear" title="Clear input">✕</button>
            </div>
            <div class="loading-bar" id="loading-bar"></div>
        </div>

        <div class="action-group">
            <!-- Zoom Controls -->
            <div class="zoom-group">
                <button class="nav-btn zoom-btn" id="btn-zoom-out" title="Zoom Out (Ctrl+Minus)">−</button>
                <button class="zoom-indicator" id="btn-zoom-reset" title="Reset Zoom (100%)">100%</button>
                <button class="nav-btn zoom-btn" id="btn-zoom-in" title="Zoom In (Ctrl+Plus)">+</button>
            </div>

            <button class="nav-btn nav-btn-login" id="btn-login-external" title="Open in System Browser (Use logged-in Chrome)">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M11 1a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h6zm-3 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm0 1c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                </svg>
                <span class="btn-text">Open in Chrome</span>
            </button>

            <button class="nav-btn" id="btn-help" title="Keyboard Shortcuts & Help">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                    <path d="M5.255 5.786a.237.237 0 0 0 .241.247h.825c.138 0 .248-.113.266-.25.09-.656.54-1.134 1.342-1.134.686 0 1.314.343 1.314 1.168 0 .635-.374.927-.965 1.371-.673.489-1.206 1.06-1.168 1.987l.003.217a.25.25 0 0 0 .25.246h.811a.25.25 0 0 0 .25-.25v-.105c0-.718.273-.927 1.01-1.486.609-.463 1.244-.977 1.244-2.056 0-1.511-1.276-2.241-2.673-2.241-1.267 0-2.655.59-2.75 2.286zm1.557 5.763c0 .533.425.927 1.01.927.609 0 1.028-.394 1.028-.927 0-.552-.42-.94-1.029-.94-.584 0-1.009.388-1.009.94z"/>
                </svg>
            </button>

            <button class="nav-btn" id="btn-external" title="Open current URL in system default browser">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                    <path d="M9 1H1v14h14V7h-2v6H3V3h6V1zm1 0l3 3-5 5 1.4 1.4L14.4 5.4 14 2h-4z"/>
                </svg>
            </button>
        </div>
    </div>

    <!-- ===== QUICK BOOKMARKS BAR ===== -->
    <div class="bookmarks-bar" id="bookmarks-bar">
        <button class="bm-item" data-url="https://www.google.com"><span class="bm-icon">🔍</span> Google</button>
        <button class="bm-item" data-url="https://www.youtube.com"><span class="bm-icon">📺</span> YouTube</button>
        <button class="bm-item" data-url="https://github.com"><span class="bm-icon">🐱</span> GitHub</button>
        <button class="bm-item" data-url="https://takeuforward.org"><span class="bm-icon">💻</span> takeuforward</button>
        <button class="bm-item" data-url="https://chatgpt.com"><span class="bm-icon">🤖</span> ChatGPT</button>
        <button class="bm-item" data-url="https://stackoverflow.com"><span class="bm-icon">❓</span> Stack Overflow</button>
    </div>

    <!-- ===== BROWSER VIEWPORT ===== -->
    <div class="viewport" id="viewport">
        <div class="login-banner hidden" id="login-banner">
            <span class="banner-icon">🔑</span>
            <span class="banner-text">Sign-in page detected. You can open this in your default Chrome browser where you're already logged in.</span>
            <button class="banner-btn" id="banner-open-chrome">Open in Chrome</button>
            <button class="banner-close" id="banner-close" title="Dismiss">✕</button>
        </div>
        <div class="splash" id="splash">
            <div class="splash-logo">🌐</div>
            <div class="splash-text">Launching browser...</div>
            <div class="splash-spinner"></div>
        </div>
        <canvas id="screencast-canvas" tabindex="0"></canvas>
    </div>

    <!-- ===== HELP MODAL ===== -->
    <div class="help-modal hidden" id="help-modal">
        <div class="help-content">
            <div class="help-header">
                <h3>⚡ Browser Navigation & Keyboard Shortcuts</h3>
                <button class="help-close" id="help-close">✕</button>
            </div>
            <div class="help-grid">
                <div class="help-item"><kbd>Ctrl</kbd> + <kbd>L</kbd> <span>Focus Address Bar</span></div>
                <div class="help-item"><kbd>F5</kbd> <span>Reload Page</span></div>
                <div class="help-item"><kbd>Alt</kbd> + <kbd>←</kbd> <span>Go Back</span></div>
                <div class="help-item"><kbd>Alt</kbd> + <kbd>→</kbd> <span>Go Forward</span></div>
                <div class="help-item"><kbd>Ctrl</kbd> + <kbd>+</kbd> <span>Zoom In</span></div>
                <div class="help-item"><kbd>Ctrl</kbd> + <kbd>-</kbd> <span>Zoom Out</span></div>
                <div class="help-item"><kbd>Esc</kbd> <span>Close Modal</span></div>
            </div>
        </div>
    </div>

    <!-- ===== STATUS BAR ===== -->
    <div class="statusbar" id="statusbar">
        <span class="status-title" id="page-title">New Tab</span>
        <span class="status-info" id="status-info">Ready</span>
        <span class="status-zoom" id="status-zoom">100%</span>
        <span class="status-fps" id="fps-counter">0 FPS</span>
    </div>

    <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

// ============================================================================
// OPEN BROWSER
// ============================================================================
async function openBrowser(context, initialUrl) {
    const config = vscode.workspace.getConfiguration('fullBrowser');
    const homepage = initialUrl || config.get('homepage', 'https://www.google.com');
    const quality = config.get('quality', 95);
    const everyNthFrame = config.get('everyNthFrame', 1);

    // --- If panel already exists, reveal it ---
    if (panel) {
        try {
            panel.reveal(vscode.ViewColumn.One);
            if (initialUrl && page) {
                try { await page.goto(initialUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }); } catch {}
            }
            return;
        } catch {
            // Panel was disposed — clean up and create a new one
            await cleanup();
            panel = null;
        }
    }

    // --- Create Webview Panel ---
    panel = vscode.window.createWebviewPanel(
        'fullBrowser',
        '🌐 ChromeX Browser',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'media'))
            ]
        }
    );

    panel.webview.html = getWebviewHtml(panel.webview, context.extensionPath);

    // --- Find Chrome ---
    const chromePath = findChromePath();
    if (!chromePath) {
        panel.webview.postMessage({
            type: 'error',
            message: 'Chrome, Edge, or Brave not found on your system.\n\nPlease install one of them, or set the path in Settings:\nSettings → Full Browser → Chrome Path'
        });
        vscode.window.showErrorMessage(
            'Full Browser: Chrome/Edge/Brave not found. Install one or set fullBrowser.chromePath in settings.',
            'Open Settings'
        ).then(choice => {
            if (choice === 'Open Settings') {
                vscode.commands.executeCommand('workbench.action.openSettings', 'fullBrowser.chromePath');
            }
        });
        return;
    }

    // --- Launch Chrome via Puppeteer ---
    try {
        // Kill any existing browser instance first (from previous session)
        if (browser) {
            try { await browser.close(); } catch {}
            browser = null;
            cdpSession = null;
            screencastRunning = false;
        }

        panel.webview.postMessage({ type: 'status', message: `Launching ${path.basename(chromePath)}...` });

        // Use a fresh temporary profile every time to avoid lock conflicts
        // This is the most reliable approach — no stale lock files, no duplicate windows
        currentUserDataDir = null;
        currentProfileMode = 'temporary';

        // --- Detect Widevine CDM from Chrome installation ---
        let widevineCdmPath = '';
        let widevineCdmVersion = '';
        try {
            const chromeDir = path.dirname(chromePath);
            // Walk version directories under Chrome's Application folder
            const entries = fs.readdirSync(chromeDir).filter(e => {
                return /^\d+\./.test(e) && fs.statSync(path.join(chromeDir, e)).isDirectory();
            });
            // Sort by version number descending to pick the latest
            entries.sort((a, b) => {
                const va = a.split('.').map(Number);
                const vb = b.split('.').map(Number);
                for (let i = 0; i < Math.max(va.length, vb.length); i++) {
                    if ((va[i] || 0) !== (vb[i] || 0)) return (vb[i] || 0) - (va[i] || 0);
                }
                return 0;
            });
            for (const ver of entries) {
                const cdmManifest = path.join(chromeDir, ver, 'WidevineCdm', 'manifest.json');
                if (fs.existsSync(cdmManifest)) {
                    widevineCdmPath = path.join(chromeDir, ver, 'WidevineCdm');
                    try {
                        const manifest = JSON.parse(fs.readFileSync(cdmManifest, 'utf8'));
                        widevineCdmVersion = manifest.version || ver;
                    } catch {
                        widevineCdmVersion = ver;
                    }
                    console.log(`[Full Browser] Found Widevine CDM: ${widevineCdmPath} (v${widevineCdmVersion})`);
                    break;
                }
            }
            // Fallback: check user data component directory
            if (!widevineCdmPath) {
                const userDataWv = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'WidevineCdm');
                if (fs.existsSync(userDataWv)) {
                    const subDirs = fs.readdirSync(userDataWv).filter(e => /^\d+\./.test(e));
                    subDirs.sort().reverse();
                    for (const sub of subDirs) {
                        const manifest = path.join(userDataWv, sub, '_platform_specific', 'win_x64', 'widevinecdm.dll');
                        if (fs.existsSync(manifest)) {
                            widevineCdmPath = path.join(userDataWv, sub);
                            widevineCdmVersion = sub;
                            console.log(`[Full Browser] Found Widevine CDM (user data): ${widevineCdmPath}`);
                            break;
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[Full Browser] Widevine CDM detection failed:', err.message);
        }

        const launchArgs = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-media-suspend',
            '--window-size=1280,800',
            // Position offscreen so real Chrome GUI stays hidden from screen
            '--window-position=-2000,-2000',
            // Audio & Media Policies for YouTube & System Speaker Output
            '--autoplay-policy=no-user-gesture-required',
            '--no-mute-audio',
            '--enable-features=AudioServiceOutOfProcess,MediaFoundationVideoCapture,HardwareMediaKeyHandling',
            // GPU Hardware Acceleration & Video Decoding
            '--ignore-gpu-blocklist',
            '--enable-gpu-rasterization',
            '--enable-zero-copy',
            '--enable-accelerated-video-decode',
            '--enable-accelerated-video-encode',
            '--enable-accelerated-2d-canvas',
            '--enable-webgl',
            '--force-color-profile=srgb',
            // Windows ANGLE DirectX 11 rendering for video pipeline
            '--use-gl=angle',
            '--use-angle=d3d11',
            // Stealth & Default Browser Checks
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
        ];

        // Register Widevine CDM if detected
        if (widevineCdmPath) {
            launchArgs.push(`--widevine-cdm-path=${widevineCdmPath}`);
            if (widevineCdmVersion) {
                launchArgs.push(`--widevine-cdm-version=${widevineCdmVersion}`);
            }
        }

        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: false,  // Non-headless so native Chrome video codecs, Widevine DRM, and system audio work
            args: launchArgs,
            defaultViewport: {
                width: 1280,
                height: 800,
            },
            ignoreDefaultArgs: ['--enable-automation', '--disable-component-update'],
        });

        mainPage = (await browser.pages())[0];
        pageStack = [mainPage];

        // Apply stealth to mainPage
        await applyStealthToPage(mainPage);

        // Setup browser target listeners for popups (OAuth flows)
        setupBrowserEvents();

        // Activate mainPage
        await setActivePage(mainPage);

        // --- Navigate to homepage ---
        panel.webview.postMessage({ type: 'status', message: 'Loading page...' });

        await activePage.goto(homepage, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});

        // Send initial URL
        panel.webview.postMessage({ type: 'urlChanged', url: activePage.url() });
        const title = await activePage.title().catch(() => 'New Tab');
        panel.webview.postMessage({ type: 'titleChanged', title });
        panel.webview.postMessage({ type: 'ready' });

        // --- Start PNG Screenshot Capture Loop ---
        startCapturing();

    } catch (err) {
        const msg = `Failed to launch browser: ${err.message}`;
        panel.webview.postMessage({ type: 'error', message: msg });
        vscode.window.showErrorMessage(`Full Browser: ${msg}`);
        return;
    }

    // --- Handle Messages from Webview ---
    panel.webview.onDidReceiveMessage(
        (msg) => handleWebviewMessage(msg, quality, everyNthFrame),
        undefined,
        context.subscriptions
    );

    // --- Handle Panel Disposal ---
    panel.onDidDispose(
        () => { stopScreencastWatchdog(); cleanup(); panel = null; },
        null,
        context.subscriptions
    );
}

// ============================================================================
// CDP SCREENCAST (Push-based frame streaming — works with off-screen Chrome)
// With watchdog timer for auto-recovery from stalled streams
// ============================================================================
let screencastRunning = false;
let lastFrameTime = 0;
let screencastWatchdog = null;
const WATCHDOG_INTERVAL = 2000;  // Check every 2 seconds
const FRAME_STALE_THRESHOLD = 3000;  // Restart if no frame for 3 seconds

async function startScreencast() {
    if (!cdpSession) return;

    // Stop any existing screencast first
    if (screencastRunning) {
        try { await cdpSession.send('Page.stopScreencast'); } catch {}
        screencastRunning = false;
    }

    try {
        // Remove old listeners to avoid duplicate frame callbacks
        cdpSession.removeAllListeners('Page.screencastFrame');

        // Listen for screencast frames pushed by Chrome
        cdpSession.on('Page.screencastFrame', (params) => {
            lastFrameTime = Date.now();
            if (panel && params.data) {
                panel.webview.postMessage({
                    type: 'screencastFrame',
                    data: params.data,
                    format: 'jpeg',
                });
            }
            // Acknowledge the frame so Chrome sends the next one
            if (cdpSession) {
                cdpSession.send('Page.screencastFrameAck', {
                    sessionId: params.sessionId,
                }).catch(() => {});
            }
        });

        const config = vscode.workspace.getConfiguration('fullBrowser');
        const quality = config.get('quality', 80);

        await cdpSession.send('Page.startScreencast', {
            format: 'jpeg',
            quality: quality,
            maxWidth: currentScreencastWidth || 1280,
            maxHeight: currentScreencastHeight || 800,
            everyNthFrame: 1,
        });

        screencastRunning = true;
        lastFrameTime = Date.now();
        console.log('[Full Browser] Screencast started:', currentScreencastWidth, 'x', currentScreencastHeight);

        // Start the watchdog
        startScreencastWatchdog();
    } catch (err) {
        console.error('[Full Browser] Failed to start screencast:', err.message);
        screencastRunning = false;
        // Fallback: take a one-shot screenshot
        await captureScreenshotFallback();
    }
}

function startScreencastWatchdog() {
    stopScreencastWatchdog();
    screencastWatchdog = setInterval(async () => {
        if (!cdpSession || !panel) {
            stopScreencastWatchdog();
            return;
        }
        const elapsed = Date.now() - lastFrameTime;
        if (elapsed > FRAME_STALE_THRESHOLD) {
            console.log(`[Full Browser] Watchdog: No frame for ${elapsed}ms, restarting screencast`);
            // Try to restart the screencast
            screencastRunning = false;
            try {
                await cdpSession.send('Page.stopScreencast');
            } catch {}
            // Brief delay then restart
            setTimeout(async () => {
                if (cdpSession && panel) {
                    await startScreencast();
                    // If still no frame after restart, take a screenshot as fallback
                    setTimeout(async () => {
                        if (Date.now() - lastFrameTime > 2000) {
                            await captureScreenshotFallback();
                        }
                    }, 1500);
                }
            }, 300);
        }
    }, WATCHDOG_INTERVAL);
}

function stopScreencastWatchdog() {
    if (screencastWatchdog) {
        clearInterval(screencastWatchdog);
        screencastWatchdog = null;
    }
}

async function captureScreenshotFallback() {
    if (!cdpSession || !panel) return;
    try {
        const result = await cdpSession.send('Page.captureScreenshot', {
            format: 'jpeg',
            quality: 75,
        });
        if (result && result.data && panel) {
            panel.webview.postMessage({
                type: 'screencastFrame',
                data: result.data,
                format: 'jpeg',
            });
            lastFrameTime = Date.now();
            console.log('[Full Browser] Screenshot fallback sent');
        }
    } catch (err) {
        console.error('[Full Browser] Screenshot fallback failed:', err.message);
    }
}

async function stopScreencast() {
    stopScreencastWatchdog();
    if (!cdpSession || !screencastRunning) return;
    try {
        await cdpSession.send('Page.stopScreencast');
    } catch {}
    screencastRunning = false;
}

// Alias used by cleanup and other parts of the code
function startCapturing() {
    startScreencast();
}

function stopCapturing() {
    stopScreencast();
}

function markActivity() {
    // With screencast, Chrome pushes frames automatically.
    // But if screen is stale, trigger a fallback screenshot
    if (cdpSession && panel && (Date.now() - lastFrameTime > 1500)) {
        captureScreenshotFallback();
    }
}

async function updateViewport(logicalW, logicalH, dpr) {
    currentDpr = dpr || 1;
    currentLogicalWidth = logicalW;
    currentLogicalHeight = logicalH;
    currentScreencastWidth = Math.round(logicalW * currentDpr);
    currentScreencastHeight = Math.round(logicalH * currentDpr);

    if (page) {
        try {
            await page.setViewport({
                width: logicalW,
                height: logicalH,
                deviceScaleFactor: currentDpr,
            });
        } catch {}
    }

    // Also resize the offscreen browser WINDOW to match the viewport
    // This ensures screencast frames fill the entire canvas without black bars
    if (browser) {
        try {
            const cdp = await browser.target().createCDPSession();
            const { windowId } = await cdp.send('Browser.getWindowForTarget');
            await cdp.send('Browser.setWindowBounds', {
                windowId,
                bounds: {
                    width: logicalW,
                    height: logicalH + 0,  // No chrome UI since using --app style
                },
            });
            await cdp.detach();
        } catch (err) {
            console.warn('[Full Browser] Could not resize browser window:', err.message);
        }
    }

    // Restart screencast at new resolution
    if (cdpSession) {
        screencastRunning = false;
        try { await cdpSession.send('Page.stopScreencast'); } catch {}
        await startScreencast();
    }
}

// ============================================================================
// CURSOR STYLE TRACKING
// ============================================================================
let cursorCheckTimer = null;
let lastCursorStyle = 'default';

function checkCursorStyle(x, y) {
    // Throttle cursor checks to avoid excessive evaluations
    if (cursorCheckTimer) return;
    cursorCheckTimer = setTimeout(async () => {
        cursorCheckTimer = null;
        if (!page || !panel) return;
        try {
            const cursor = await page.evaluate((px, py) => {
                const el = document.elementFromPoint(px, py);
                if (!el) return 'default';
                return window.getComputedStyle(el).cursor || 'default';
            }, x, y);

            if (cursor !== lastCursorStyle) {
                lastCursorStyle = cursor;
                panel.webview.postMessage({
                    type: 'cursorChanged',
                    cursor: cursor,
                });
            }
        } catch {}
    }, 80); // Check ~12 times/sec max
}

// ============================================================================
// ============================================================================
// BULLETPROOF STEALTH ENGINE (For Google Sign-In, OAuth & Anti-Bot)
// ============================================================================
async function applyStealthToPage(targetPage) {
    if (!targetPage) return;
    try {
        await targetPage.evaluateOnNewDocument(() => {
            // 1. Prototype-level removal of webdriver flag
            try {
                const navProto = Object.getPrototypeOf(navigator);
                delete navProto.webdriver;
                delete navigator.webdriver;
                Object.defineProperty(navProto, 'webdriver', {
                    get: () => undefined,
                    enumerable: false,
                    configurable: true
                });
            } catch {}

            // 2. Realistic window coordinates & dimensions (Fix Google's -32000 bot detection)
            try {
                Object.defineProperty(window, 'screenX', { get: () => 0, configurable: true });
                Object.defineProperty(window, 'screenY', { get: () => 0, configurable: true });
                Object.defineProperty(window, 'screenLeft', { get: () => 0, configurable: true });
                Object.defineProperty(window, 'screenTop', { get: () => 0, configurable: true });
                Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth || 1280, configurable: true });
                Object.defineProperty(window, 'outerHeight', { get: () => (window.innerHeight || 800) + 80, configurable: true });
            } catch {}

            // 3. Complete window.chrome mock
            try {
                if (!window.chrome) window.chrome = {};
                window.chrome.app = window.chrome.app || {
                    isInstalled: false,
                    InstallState: { DISABLED: 'Disabled', INSTALLED: 'Installed', NOT_INSTALLED: 'NotInstalled' },
                    RunningState: { CANNOT_RUN: 'CannotRun', READY_TO_RUN: 'ReadyToRun', RUNNING: 'Running' }
                };
                window.chrome.csi = window.chrome.csi || function() { return { startE: Date.now(), onloadT: Date.now() + 100, pageT: 150, tran: 15 }; };
                window.chrome.loadTimes = window.chrome.loadTimes || function() {
                    return {
                        requestTime: (Date.now() - 500) / 1000,
                        startLoadTime: (Date.now() - 400) / 1000,
                        commitLoadTime: (Date.now() - 300) / 1000,
                        finishDocumentLoadTime: (Date.now() - 100) / 1000,
                        finishLoadTime: Date.now() / 1000,
                        firstPaintTime: (Date.now() - 200) / 1000,
                        firstPaintAfterLoadTime: 0,
                        navigationType: 'Other',
                        wasFetchedViaSpdy: true,
                        wasNpnNegotiated: true,
                        npnNegotiatedProtocol: 'h2',
                        wasAlternateProtocolAvailable: false,
                        connectionInfo: 'h2'
                    };
                };
                if (!window.chrome.runtime) {
                    window.chrome.runtime = {
                        OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
                        OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
                        PlatformArch: { ARM: 'arm', ARM64: 'arm64', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                        PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
                        PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
                        RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
                        connect: function() { return { postMessage: function() {}, onMessage: { addListener: function() {} } }; },
                        sendMessage: function(msg, cb) { if (cb) cb(); }
                    };
                }
            } catch {}

            // 4. Realistic User-Agent Client Hints (Google Sign-In checks userAgentData)
            try {
                if (navigator.userAgentData) {
                    Object.defineProperty(navigator, 'userAgentData', {
                        get: () => ({
                            brands: [
                                { brand: 'Google Chrome', version: '124' },
                                { brand: 'Chromium', version: '124' },
                                { brand: 'Not-A.Brand', version: '99' }
                            ],
                            mobile: false,
                            platform: 'Windows',
                            getHighEntropyValues: async () => ({
                                architecture: 'x86',
                                bitness: '64',
                                brands: [
                                    { brand: 'Google Chrome', version: '124' },
                                    { brand: 'Chromium', version: '124' },
                                    { brand: 'Not-A.Brand', version: '99' }
                                ],
                                fullVersionList: [
                                    { brand: 'Google Chrome', version: '124.0.6367.201' },
                                    { brand: 'Chromium', version: '124.0.6367.201' },
                                    { brand: 'Not-A.Brand', version: '99.0.0.0' }
                                ],
                                mobile: false,
                                model: '',
                                platform: 'Windows',
                                platformVersion: '15.0.0',
                                uaFullVersion: '124.0.6367.201'
                            })
                        })
                    });
                }
            } catch {}

            // 5. Realistic plugins and languages
            try {
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [
                        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
                        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
                        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
                    ],
                });
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });
            } catch {}

            // 6. WebGL Vendor & Renderer spoofing (avoid SwiftShader detection)
            try {
                const getParam = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(param) {
                    if (param === 37445) return 'Google Inc. (NVIDIA)';
                    if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                    return getParam.apply(this, arguments);
                };
                if (window.WebGL2RenderingContext) {
                    const getParam2 = WebGL2RenderingContext.prototype.getParameter;
                    WebGL2RenderingContext.prototype.getParameter = function(param) {
                        if (param === 37445) return 'Google Inc. (NVIDIA)';
                        if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
                        return getParam2.apply(this, arguments);
                    };
                }
            } catch {}

            // 7. Fix permissions query
            try {
                const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
                window.navigator.permissions.query = (params) => {
                    if (params.name === 'notifications') {
                        return Promise.resolve({ state: Notification.permission || 'default' });
                    }
                    return originalQuery(params);
                };
            } catch {}

            // ===============================================================
            // 8. CRITICAL: Remove CDP (Chrome DevTools Protocol) markers
            //    Google uses these to detect Puppeteer/automation
            // ===============================================================

            // 8a. Remove cdc_ properties that CDP injects into document
            try {
                const cleanCdc = () => {
                    for (const key of Object.keys(document)) {
                        if (/^\$?cdc_/.test(key)) {
                            delete document[key];
                        }
                    }
                    for (const key of Object.keys(window)) {
                        if (/^\$?cdc_/.test(key)) {
                            delete window[key];
                        }
                    }
                };
                cleanCdc();
                // Re-clean periodically since CDP can re-inject
                setInterval(cleanCdc, 500);
            } catch {}

            // 8b. Prevent console.debug CDP leak detection
            //     Google uses Object.getOwnPropertyDescriptor on console methods
            //     to detect if Runtime.enable was called (CDP side-effect)
            try {
                const nativeDebug = console.debug;
                const nativeLog = console.log;
                // Freeze console methods to look native
                ['debug', 'log', 'info', 'warn', 'error', 'trace', 'dir'].forEach(method => {
                    const original = console[method];
                    if (original) {
                        Object.defineProperty(console, method, {
                            value: original,
                            writable: false,
                            configurable: false,
                            enumerable: true
                        });
                    }
                });
            } catch {}

            // 8c. Protect Function.prototype.toString from revealing patched functions
            try {
                const origToString = Function.prototype.toString;
                const nativeFnRegex = /^function\s.*\{\s*\[native code\]\s*\}$/;
                Function.prototype.toString = function() {
                    // For our patched functions, return native-looking output
                    if (this === Function.prototype.toString) {
                        return 'function toString() { [native code] }';
                    }
                    const result = origToString.call(this);
                    return result;
                };
                // Make toString itself look native
                Object.defineProperty(Function.prototype.toString, 'toString', {
                    value: () => 'function toString() { [native code] }',
                    configurable: false,
                    writable: false,
                });
            } catch {}

            // 8d. Prevent stack trace analysis revealing CDP
            try {
                const origStack = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
                if (origStack && origStack.get) {
                    Object.defineProperty(Error.prototype, 'stack', {
                        get: function() {
                            const stack = origStack.get.call(this);
                            if (typeof stack === 'string') {
                                // Remove CDP-related frames from stack traces
                                return stack
                                    .split('\n')
                                    .filter(line => !line.includes('puppeteer') && !line.includes('devtools'))
                                    .join('\n');
                            }
                            return stack;
                        },
                        set: origStack.set,
                        configurable: true,
                    });
                }
            } catch {}

            // 8e. navigator.connection spoofing (bots often lack this)
            try {
                if (!navigator.connection) {
                    Object.defineProperty(navigator, 'connection', {
                        get: () => ({
                            effectiveType: '4g',
                            rtt: 50,
                            downlink: 10,
                            saveData: false,
                            onchange: null,
                            addEventListener: function() {},
                            removeEventListener: function() {},
                        }),
                        configurable: true,
                    });
                }
            } catch {}

            // 8f. Screen and hardware properties
            try {
                Object.defineProperty(navigator, 'hardwareConcurrency', {
                    get: () => 8,
                    configurable: true,
                });
                Object.defineProperty(navigator, 'deviceMemory', {
                    get: () => 8,
                    configurable: true,
                });
                Object.defineProperty(navigator, 'maxTouchPoints', {
                    get: () => 0,
                    configurable: true,
                });
            } catch {}

            // 8g. Smart YouTube & HTML5 Video Seeking Error Auto-Recovery
            try {
                let lastSeekTime = 0;

                document.addEventListener('seeking', (e) => {
                    if (e.target && e.target.tagName === 'VIDEO') {
                        lastSeekTime = e.target.currentTime;
                    }
                }, true);

                window.addEventListener('error', (e) => {
                    if (e && e.target && e.target.tagName === 'VIDEO') {
                        const v = e.target;
                        if (v.error) {
                            console.log('[MediaRecovery] Resuming seek position:', lastSeekTime);
                            setTimeout(() => {
                                try {
                                    if (lastSeekTime > 0) v.currentTime = lastSeekTime;
                                    v.play().catch(() => {});
                                } catch {}
                            }, 300);
                        }
                    }
                }, true);

                // Auto-recover if YouTube shows error screen overlay during seeking
                setInterval(() => {
                    try {
                        const errScreen = document.querySelector('.ytp-error');
                        if (errScreen && errScreen.offsetWidth > 0 && errScreen.offsetHeight > 0) {
                            const v = document.querySelector('video');
                            if (v) {
                                console.log('[MediaRecovery] Auto-recovering YouTube player from error overlay');
                                const cur = v.currentTime || lastSeekTime;
                                const retryBtn = document.querySelector('.ytp-error-content button, .ytp-button');
                                if (retryBtn) {
                                    retryBtn.click();
                                } else {
                                    v.currentTime = cur;
                                    v.play().catch(() => {});
                                }
                            }
                        }
                    } catch {}
                }, 1000);
            } catch {}

            // 8h. Automatic audio unmuting & AudioContext auto-resume for YouTube & video playback
            try {
                const unmuteMedia = () => {
                    document.querySelectorAll('video, audio').forEach(m => {
                        m.muted = false;
                        m.volume = 1.0;
                    });
                };
                window.addEventListener('load', unmuteMedia);
                window.addEventListener('play', unmuteMedia, true);
                setInterval(unmuteMedia, 2000);
            } catch {}
        });
    } catch {}
}

// ============================================================================
// DYNAMIC PAGE & CDP SESSION SWITCHING (For Popups & OAuth)
// ============================================================================
const setupPagesSet = new WeakSet();

async function setActivePage(targetPage) {
    if (!targetPage || targetPage.isClosed()) return;
    activePage = targetPage;
    page = targetPage; // alias

    // Detach existing CDP session and stop screencast
    screencastRunning = false;
    if (cdpSession) {
        try { await cdpSession.detach(); } catch {}
        cdpSession = null;
    }

    try {
        cdpSession = await activePage.createCDPSession();
        console.log('[Full Browser] CDP session created successfully');
        await cdpSession.send('Page.enable');
        await cdpSession.send('DOM.enable');

        cdpSession.on('Page.frameStartedLoading', () => {
            if (panel) panel.webview.postMessage({ type: 'loadingChanged', loading: true });
        });
        cdpSession.on('Page.frameStoppedLoading', () => {
            if (panel) panel.webview.postMessage({ type: 'loadingChanged', loading: false });
        });

        cdpSession.on('disconnected', () => {
            console.log('[Full Browser] CDP session disconnected');
            stopScreencastWatchdog();
            cdpSession = null;
            screencastRunning = false;
        });
    } catch (err) {
        console.error('[Full Browser] Failed to create CDP session:', err.message);
    }

    // Match viewport
    if (currentLogicalWidth > 0 && currentLogicalHeight > 0) {
        try {
            await activePage.setViewport({
                width: currentLogicalWidth,
                height: currentLogicalHeight,
                deviceScaleFactor: currentDpr || 1,
            });
        } catch {}
    }

    setupPageEventsFor(activePage);

    if (panel) {
        const url = activePage.url();
        const title = await activePage.title().catch(() => 'Page');
        panel.webview.postMessage({ type: 'urlChanged', url });
        panel.webview.postMessage({ type: 'titleChanged', title });
        panel.webview.postMessage({ type: 'securityChanged', secure: url.startsWith('https://') });
    }

    // Start screencast for the new page
    await startScreencast();
}

function setupPageEventsFor(targetPage) {
    if (!targetPage || setupPagesSet.has(targetPage)) return;
    setupPagesSet.add(targetPage);

    targetPage.on('framenavigated', (frame) => {
        if (targetPage === activePage && frame === targetPage.mainFrame() && panel) {
            const url = frame.url();
            panel.webview.postMessage({ type: 'urlChanged', url });
            panel.webview.postMessage({
                type: 'securityChanged',
                secure: url.startsWith('https://')
            });
        }
    });

    targetPage.on('load', async () => {
        if (targetPage === activePage && panel) {
            const title = await targetPage.title().catch(() => '');
            panel.webview.postMessage({ type: 'titleChanged', title });
            panel.webview.postMessage({ type: 'loadingChanged', loading: false });
            // Restart screencast after page load to ensure frames flow
            if (cdpSession) {
                screencastRunning = false;
                await startScreencast();
            }
        }
    });

    targetPage.on('domcontentloaded', async () => {
        if (targetPage === activePage && panel) {
            const title = await targetPage.title().catch(() => '');
            panel.webview.postMessage({ type: 'titleChanged', title });
        }
    });

    targetPage.on('error', (err) => {
        if (targetPage === activePage && panel) {
            panel.webview.postMessage({
                type: 'error',
                message: `Page crashed: ${err.message}`
            });
        }
    });

    targetPage.on('console', (msg) => {
        if (targetPage === activePage && panel) {
            panel.webview.postMessage({
                type: 'consoleMessage',
                level: msg.type(),
                text: msg.text(),
            });
        }
    });
}

function setupBrowserEvents() {
    if (!browser) return;

    // Handle real popups (like Google Sign-In GIS / OAuth popups)
    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page' && panel) {
            try {
                const newPage = await target.page();
                if (!newPage || newPage === activePage || pageStack.includes(newPage)) return;

                // Wait briefly for the popup URL to resolve
                await new Promise(r => setTimeout(r, 300));
                const popupUrl = newPage.url() || '';

                // Check if this is a Google OAuth / sign-in popup
                const isGoogleAuth = popupUrl.includes('accounts.google.com') ||
                                     popupUrl.includes('accounts.youtube.com');

                if (isGoogleAuth) {
                    // Google blocks Puppeteer-controlled browsers from OAuth.
                    // Auto-open the PARENT site in user's real Chrome with their profile.
                    await newPage.close().catch(() => {});
                    const parentUrl = mainPage ? mainPage.url() : popupUrl;
                    openInUserChrome(parentUrl);
                    vscode.window.showInformationMessage(
                        '🔑 Google Sign-In opened in Chrome. Log in there, then click "Sync Session" to bring your login back.',
                        'Sync Session'
                    ).then(async (choice) => {
                        if (choice === 'Sync Session') {
                            await syncCookiesViaCDP();
                        }
                    });
                    return;
                }

                // For non-Google popups, handle in-app
                await applyStealthToPage(newPage);

                // Push onto stack and seamlessly activate popup so window.opener stays intact!
                pageStack.push(newPage);
                await setActivePage(newPage);

                // When popup closes (e.g. login finished), automatically switch back to main page!
                newPage.on('close', async () => {
                    pageStack = pageStack.filter(p => p !== newPage && !p.isClosed());
                    const topPage = pageStack[pageStack.length - 1] || mainPage;
                    if (topPage && !topPage.isClosed()) {
                        await setActivePage(topPage);
                    }
                });
            } catch (err) {
                console.error('Error handling new popup target:', err);
            }
        }
    });
}

// ============================================================================
// HANDLE MESSAGES FROM WEBVIEW
// ============================================================================
async function handleWebviewMessage(msg, quality, everyNthFrame) {
    if (!page && msg.type !== 'resize') return;

    try {
        switch (msg.type) {
            // ----- Navigation -----
            case 'navigate': {
                let url = msg.url.trim();
                // Auto-prepend https:// if needed
                if (!url.match(/^[a-zA-Z]+:\/\//)) {
                    if (url.includes('.') && !url.includes(' ')) {
                        url = 'https://' + url;
                    } else {
                        url = 'https://www.google.com/search?q=' + encodeURIComponent(url);
                    }
                }
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(err => {
                    if (panel) {
                        panel.webview.postMessage({ type: 'status', message: `Navigation error: ${err.message}` });
                    }
                });
                break;
            }
            case 'goBack': {
                if (activePage) {
                    try {
                        const historyLength = await activePage.evaluate(() => window.history.length);
                        if (historyLength > 1) {
                            await activePage.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                        } else if (pageStack.length > 1) {
                            const pageToClose = activePage;
                            pageStack = pageStack.filter(p => p !== pageToClose);
                            const prevPage = pageStack[pageStack.length - 1] || mainPage;
                            await setActivePage(prevPage);
                            await pageToClose.close().catch(() => {});
                        }
                    } catch {}
                }
                break;
            }

            case 'goForward':
                if (activePage) {
                    await activePage.goForward({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                }
                break;

            case 'reload':
                if (activePage) {
                    await activePage.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                }
                break;

            case 'home': {
                const config = vscode.workspace.getConfiguration('fullBrowser');
                const hp = config.get('homepage', 'https://www.google.com');
                if (activePage) {
                    await activePage.goto(hp, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
                }
                break;
            }

            // ----- Mouse Input -----
            case 'mouseEvent':
                markActivity();
                if (cdpSession) {
                    let buttons = 0;
                    if (msg.eventType !== 'mouseReleased') {
                        if (msg.button === 'left') buttons = 1;
                        else if (msg.button === 'right') buttons = 2;
                        else if (msg.button === 'middle') buttons = 4;
                    }

                    // Before mousePressed, send a mouseMoved so Chrome knows cursor position
                    if (msg.eventType === 'mousePressed') {
                        cdpSession.send('Input.dispatchMouseEvent', {
                            type: 'mouseMoved',
                            x: msg.x,
                            y: msg.y,
                            buttons: buttons,
                            modifiers: msg.modifiers || 0,
                        }).catch(() => {});
                    }

                    cdpSession.send('Input.dispatchMouseEvent', {
                        type: msg.eventType,
                        x: msg.x,
                        y: msg.y,
                        button: msg.button || 'left',
                        buttons: buttons,
                        clickCount: msg.clickCount || 1,
                        modifiers: msg.modifiers || 0,
                    }).catch(() => {});

                    // Track cursor style on mouse move (throttled)
                    if (msg.eventType === 'mouseMoved' && activePage && panel) {
                        checkCursorStyle(msg.x, msg.y);
                    }
                }
                break;

            // ----- Scroll / Wheel (fire-and-forget for low latency) -----
            case 'wheelEvent':
                markActivity();
                if (cdpSession) {
                    cdpSession.send('Input.dispatchMouseEvent', {
                        type: 'mouseWheel',
                        x: msg.x,
                        y: msg.y,
                        deltaX: msg.deltaX || 0,
                        deltaY: msg.deltaY || 0,
                        modifiers: msg.modifiers || 0,
                    }).catch(() => {});
                }
                break;

            // ----- Keyboard Input (fire-and-forget for low latency) -----
            case 'keyEvent':
                markActivity();
                if (cdpSession) {
                    // Map rawKeyDown → keyDown for CDP, keep char and keyUp as-is
                    const eventType = msg.eventType === 'rawKeyDown' ? 'keyDown' : msg.eventType;
                    // IMPORTANT: For keyDown events, do NOT set text for printable chars —
                    // the separate 'char' event handles text insertion.
                    // Only set text for special keys (Enter) on keyDown.
                    let text = msg.text || '';
                    if (!text && eventType === 'keyDown') {
                        // Only fill text for non-printable action keys
                        if (msg.key === 'Enter') text = '\r';
                        if (msg.key === 'Tab') text = '\t';
                        // Do NOT fill text = msg.key for printable chars — the 'char' event does that
                    }
                    const params = {
                        type: eventType,
                        modifiers: msg.modifiers || 0,
                        key: msg.key || '',
                        code: msg.code || '',
                        text: text,
                        unmodifiedText: text,
                        windowsVirtualKeyCode: msg.keyCode || 0,
                        nativeVirtualKeyCode: msg.keyCode || 0,
                    };
                    cdpSession.send('Input.dispatchKeyEvent', params).catch(() => {});
                }
                break;

            // ----- Viewport Resize -----
            case 'resize':
                if (msg.width > 0 && msg.height > 0) {
                    const dpr = msg.dpr || 1;
                    await updateViewport(
                        Math.round(msg.width),
                        Math.round(msg.height),
                        dpr
                    );
                }
                break;

            // ----- Open in external browser -----
            case 'openExternal':
                if (activePage) {
                    let targetUrl = activePage.url();
                    // If we are currently inside a Google Sign-in popup or GIS subpage, open the main parent site
                    if (targetUrl.includes('accounts.google.com') && mainPage) {
                        targetUrl = mainPage.url();
                    }
                    openInUserChrome(targetUrl);
                }
                break;

            // ----- Login in external browser, then sync cookies back -----
            case 'loginExternal': {
                if (activePage) {
                    let targetUrl = activePage.url();
                    if (targetUrl.includes('accounts.google.com') && mainPage) {
                        targetUrl = mainPage.url();
                    }
                    openInUserChrome(targetUrl);
                    vscode.window.showInformationMessage(
                        '🔑 Log in on Chrome, then click "Sync Session" to bring your login back here.',
                        'Sync Session'
                    ).then(async (choice) => {
                        if (choice === 'Sync Session') {
                            await syncCookiesViaCDP();
                        }
                    });
                }
                break;
            }

            // ----- Sync cookies from Chrome at runtime -----
            case 'syncSession': {
                await syncCookiesViaCDP();
                break;
            }

            // ----- DevTools -----
            case 'devtools':
                vscode.window.showInformationMessage(
                    'DevTools: Check the Output panel (View → Output → Full Browser) for console logs.'
                );
                break;

            // ----- Zoom Controls -----
            case 'zoomIn':
                currentZoom = Math.min(2.5, +(currentZoom + 0.1).toFixed(2));
                if (cdpSession) {
                    await cdpSession.send('Emulation.setPageScaleFactor', { pageScaleFactor: currentZoom }).catch(() => {});
                }
                if (panel) panel.webview.postMessage({ type: 'zoomChanged', zoom: Math.round(currentZoom * 100) });
                break;

            case 'zoomOut':
                currentZoom = Math.max(0.5, +(currentZoom - 0.1).toFixed(2));
                if (cdpSession) {
                    await cdpSession.send('Emulation.setPageScaleFactor', { pageScaleFactor: currentZoom }).catch(() => {});
                }
                if (panel) panel.webview.postMessage({ type: 'zoomChanged', zoom: Math.round(currentZoom * 100) });
                break;

            case 'zoomReset':
                currentZoom = 1.0;
                if (cdpSession) {
                    await cdpSession.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.0 }).catch(() => {});
                }
                if (panel) panel.webview.postMessage({ type: 'zoomChanged', zoom: 100 });
                break;

            // ----- Check navigation state -----
            case 'checkNavState':
                if (activePage && panel) {
                    try {
                        const historyLength = await activePage.evaluate(() => window.history.length);
                        panel.webview.postMessage({
                            type: 'navState',
                            canGoBack: historyLength > 1 || pageStack.length > 1,
                            canGoForward: false,
                        });
                    } catch {}
                }
                break;
        }
    } catch (err) {
        console.error('Error handling webview message:', err);
    }
}

// ============================================================================
// CLEANUP
// ============================================================================
async function cleanup() {
    stopCapturing();
    if (cdpSession) {
        try { await cdpSession.detach(); } catch {}
        cdpSession = null;
    }
    if (browser) {
        try { await browser.close(); } catch {}
        browser = null;
    }
    mainPage = null;
    activePage = null;
    page = null;
    pageStack = [];
    currentUserDataDir = null;
    currentProfileMode = null;
}

// ============================================================================
// DEACTIVATION
// ============================================================================
function deactivate() {
    cleanup();
}

module.exports = { activate, deactivate };
