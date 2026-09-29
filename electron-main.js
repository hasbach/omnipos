import { app, BrowserWindow, dialog, ipcMain, screen, shell } from 'electron';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { fork } from 'child_process';
import { createRequire } from 'module';
import dgram from 'dgram';
import net from 'net';

const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater');

// Configure updater logging
autoUpdater.logger = require('electron-log');
autoUpdater.logger.transports.file.level = 'info';
autoUpdater.autoDownload = false;   // We control when to download
autoUpdater.autoInstallOnAppQuit = true;  // Auto-apply on next quit
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Config paths ---
const dataDir = process.env.APPDATA || path.join(process.env.HOME || '', '.config');
const appDataDir = path.join(dataDir, 'OmniPOS');
if (!fs.existsSync(appDataDir)) fs.mkdirSync(appDataDir, { recursive: true });
const CONFIG_PATH = path.join(appDataDir, 'network-config.json');

function readConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {}
  return null;
}

function writeConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

// --- UDP Network Scanner (runs in main process) ---
function scanForServers(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found = [];
    const DISCOVERY_PORT = 47777;
    const BEACON_PREFIX = 'OMNIPOS_SERVER:';

    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
    });

    socket.on('message', (msg) => {
      const str = msg.toString();
      if (str.startsWith(BEACON_PREFIX)) {
        const address = str.slice(BEACON_PREFIX.length);
        if (!found.includes(address)) found.push(address);
      }
    });

    socket.on('error', () => {});

    setTimeout(() => {
      try { socket.close(); } catch {}
      resolve(found);
    }, timeoutMs);
  });
}

// --- Setup Window ---
let setupWindow = null;
let mainWindow = null;
let serverProcess = null;

function openSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 560,
    height: 620,
    title: 'OmniPOS — Terminal Setup',
    frame: false,
    resizable: false,
    center: true,
    icon: path.join(__dirname, '..', 'assets', 'posicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'setup-preload.cjs'),
    },
  });

  const setupPath = path.resolve(__dirname, '..', 'dist-server', 'setup.html');
  setupWindow.loadFile(setupPath);

  // IPC: scan for servers
  ipcMain.handle('setup:scan-network', async () => {
    return await scanForServers(4000);
  });

  // IPC: save config and proceed
  ipcMain.handle('setup:save-config', async (event, config) => {
    // Keep any store connections already saved (setup only knows about this register's own mode).
    const previous = readConfig();
    if (previous && Array.isArray(previous.connections) && config && !config.connections) {
      config = { ...config, connections: previous.connections };
    }
    writeConfig(config);
    setupWindow?.close();
    setupWindow = null;
    launchMain(config);
    return { success: true };
  });

  // IPC: close setup
  ipcMain.on('setup:close', () => {
    setupWindow?.close();
    app.quit();
  });

  setupWindow.on('closed', () => { setupWindow = null; });
}

// --- Main POS Window ---
function launchMain(config) {
  // Fit the window to whatever display it's actually launched on (POS terminals come in all
  // shapes, including square/portrait screens far smaller than the 1280x800 default) instead of
  // always opening at a fixed size that can exceed the screen and push content off-screen.
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.min(1280, screenWidth);
  const windowHeight = Math.min(800, screenHeight);
  const fillsScreen = windowWidth >= screenWidth || windowHeight >= screenHeight;

  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    title: 'OmniPOS',
    autoHideMenuBar: true,
    frame: false,
    icon: path.join(__dirname, '..', 'assets', 'posicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  });

  // When the display is smaller than the default window (e.g. a square kiosk screen), start
  // maximized so nothing is left off-screen and the user isn't stuck resizing a frameless window.
  if (fillsScreen) {
    mainWindow.maximize();
  }

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  // === AUTO-UPDATER SETUP ===
  // Helper to push status events to EVERY open window. The Admin Dashboard (and its Settings
  // page, which now has a manual "Check for Updates" button) runs in a separate window opened
  // with target="_blank", so sending only to mainWindow would leave that window in the dark.
  const sendStatus = (event, payload = {}) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win && !win.isDestroyed()) {
        win.webContents.send('updater:status', { event, ...payload });
      }
    }
  };

  autoUpdater.on('checking-for-update', () => sendStatus('checking'));
  autoUpdater.on('update-available', (info) => sendStatus('available', { version: info.version, releaseDate: info.releaseDate }));
  autoUpdater.on('update-not-available', (info) => sendStatus('not-available', { version: info.version }));
  autoUpdater.on('download-progress', (progress) => sendStatus('progress', {
    percent: Math.round(progress.percent),
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond
  }));
  autoUpdater.on('update-downloaded', (info) => sendStatus('downloaded', { version: info.version }));
  autoUpdater.on('error', (err) => sendStatus('error', { message: err.message }));

  // IPC: renderer requests check. Return a small SERIALIZABLE summary (the raw UpdateCheckResult
  // carries a CancellationToken that can't cross IPC) and never reject, so the renderer can always
  // resolve its "checking" state. `checked:false` means the updater skipped the check — which is
  // what happens in an unpackaged/dev build (app.isPackaged === false).
  ipcMain.handle('updater:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, checked: !!result, version: result?.updateInfo?.version || null };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
  // IPC: renderer approves download
  ipcMain.handle('updater:download', () => autoUpdater.downloadUpdate());
  // IPC: renderer requests quit-and-install
  ipcMain.on('updater:install', () => autoUpdater.quitAndInstall(false, true));

  // Check for updates silently 10 seconds after launch (only in production)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates(), 10000);
  }
  // === END AUTO-UPDATER ===

  // Window control IPC
  ipcMain.removeAllListeners('window-minimize');
  ipcMain.removeAllListeners('window-maximize');
  ipcMain.removeAllListeners('window-close');

  ipcMain.on('window-minimize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });
  ipcMain.on('window-maximize', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) win.unmaximize();
    else win?.maximize();
  });
  ipcMain.on('window-close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  // Silent printing IPC — the receipt-printing fallback (usePos.ts) calls this when no ESC/POS
  // printer (network/USB — see server/printing/transport.ts) is configured, or a direct print to
  // one failed. Renders the given HTML off-screen and prints it to the OS default printer with
  // silent:true, so no Windows print dialog interrupts a normal sale — that dialog was the actual
  // reported bug, not a missing printing architecture.
  //
  // webContents.print()'s callback can simply never fire when the machine has no printer at all
  // (confirmed in testing — Windows' print pipeline hangs instead of failing fast), so this forces
  // the hidden window closed and resolves after a timeout rather than leaking a window + a stuck
  // print job every time a printerless machine hits Print.
  ipcMain.removeHandler('print:silent-html');
  ipcMain.handle('print:silent-html', async (event, { html }) => {
    return new Promise((resolve) => {
      const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(giveUp);
        // destroy(), not close() — with a print job stuck in Chromium's pipeline (the same
        // condition that makes the callback never fire on its own), close() alone was observed
        // to leave the hidden window open indefinitely. destroy() forces it regardless.
        if (!printWin.isDestroyed()) printWin.destroy();
        resolve(result);
      };
      const giveUp = setTimeout(() => finish({ success: false, error: 'Printing timed out' }), 10000);
      printWin.webContents.once('did-finish-load', () => {
        printWin.webContents.print({ silent: true, margins: { marginType: 'none' } }, (success, failureReason) => {
          finish({ success, error: success ? null : failureReason });
        });
      });
      printWin.webContents.once('did-fail-load', (_e, _code, description) => {
        finish({ success: false, error: description || 'Failed to render receipt for printing' });
      });
      printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    });
  });

  if (config.mode === 'host') {
    // HOST MODE: start local server, then load it
    startLocalServer(config, () => {
      const url = `http://127.0.0.1:3000/?terminalId=${encodeURIComponent(config.terminalId || 'MAIN')}`;
      mainWindow.loadURL(url);
    });
  } else {
    // CLIENT MODE: skip local server, load the remote host
    const baseUrl = config.hostAddress || 'http://127.0.0.1:3000';
    const url = `${baseUrl}/?terminalId=${encodeURIComponent(config.terminalId || 'POS')}`;
    mainWindow.loadURL(url);
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  // Origin of this register's own app server (trusted for the connections IPC + Ctrl+Shift+O).
  try {
    ownOrigin = new URL(config.mode === 'host' ? 'http://127.0.0.1:3000' : (config.hostAddress || 'http://127.0.0.1:3000')).origin;
  } catch { ownOrigin = 'http://127.0.0.1:3000'; }
  attachConnectionsShortcut(mainWindow);

  // Force all child windows (e.g. dashboard) to be frameless
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openOutsideLinkExternally(mainWindow, url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        frame: false,
        autoHideMenuBar: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          preload: path.join(__dirname, 'electron-preload.cjs'),
        },
      },
    };
  });

  // Also remove menu from any child windows after they're created
  mainWindow.webContents.on('did-create-window', (childWindow) => {
    childWindow.setMenu(null);
    attachConnectionsShortcut(childWindow);
    // The dashboard (Live Monitor page included) is a child window: same external-link rule there.
    childWindow.webContents.setWindowOpenHandler(({ url }) =>
      openOutsideLinkExternally(childWindow, url) ? { action: 'deny' } : { action: 'allow' });
  });
}

// Links to anything other than this app's own server (the online Live Monitor, or this host's LAN
// address copied from the Live Monitor page) open in the system browser instead of an app window.
function openOutsideLinkExternally(win, url) {
  try {
    const target = new URL(url);
    const own = new URL(win.webContents.getURL());
    if (/^https?:$/.test(target.protocol) && target.origin !== own.origin) {
      shell.openExternal(url);
      return true;
    }
  } catch { /* not a URL we can reason about */ }
  return false;
}

// === STORE CONNECTIONS (second window for another store) ===
// network-config.json gains `connections: [{ id, name, url }]`. Each opens in its OWN frameless
// window with its own `persist:conn-<id>` session so logins/cookies never mix with this register's.
let ownOrigin = 'http://127.0.0.1:3000';
const connectionWindows = new Map(); // id -> BrowserWindow

function getConnections() {
  const cfg = readConfig();
  return Array.isArray(cfg?.connections) ? cfg.connections.filter((c) => c && c.id && c.url) : [];
}

function saveConnections(list) {
  const cfg = readConfig() || {};
  writeConfig({ ...cfg, connections: list });
}

// Only pages served by this register's own server may drive the connections API (never a remote
// store's page loaded in a connection window, which shares the same preload).
function isTrustedSender(event) {
  try {
    return new URL(event.senderFrame?.url || event.sender.getURL()).origin === ownOrigin;
  } catch { return false; }
}

function normalizeStoreUrl(raw) {
  const u = new URL(String(raw || '').trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('URL_PROTOCOL');
  return u.origin;
}

async function checkReachable(url) {
  try {
    const res = await fetch(`${url}/api/auth/me`, { signal: AbortSignal.timeout(4000) });
    return res.status === 200 || res.status === 401;
  } catch { return false; }
}

function openConnectionWindow(conn) {
  const existing = connectionWindows.get(conn.id);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.focus();
    return;
  }
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: Math.min(1280, sw),
    height: Math.min(800, sh),
    title: conn.name,
    autoHideMenuBar: true,
    frame: false,
    icon: path.join(__dirname, '..', 'assets', 'posicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      partition: `persist:conn-${conn.id}`,
      preload: path.join(__dirname, 'electron-preload.cjs'),
    },
  });
  win.setMenu(null);
  connectionWindows.set(conn.id, win);
  win.on('closed', () => connectionWindows.delete(conn.id));
  // The window title is the store name, whatever the remote page calls itself.
  win.on('page-title-updated', (e) => { e.preventDefault(); win.setTitle(conn.name); });
  // Same external-link rule as the main window; in-app popups (dashboard) stay frameless.
  // Popups opened with window.open inherit this window's session partition.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (openOutsideLinkExternally(win, url)) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        frame: false,
        autoHideMenuBar: true,
        webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'electron-preload.cjs') },
      },
    };
  });
  win.webContents.on('did-create-window', (child) => {
    child.setMenu(null);
    child.webContents.setWindowOpenHandler(({ url }) =>
      openOutsideLinkExternally(child, url) ? { action: 'deny' } : { action: 'allow' });
  });
  const cfg = readConfig() || {};
  const terminal = cfg.terminalId || (cfg.mode === 'host' ? 'MAIN' : 'POS');
  win.loadURL(`${conn.url}/?terminalId=${encodeURIComponent(terminal)}`);
}

function registerConnectionsIpc() {
  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, arg) => {
      if (!isTrustedSender(event)) return { ok: false, error: 'FORBIDDEN' };
      try { return await fn(event, arg); } catch (err) { return { ok: false, error: err?.message || 'ERROR' }; }
    });
  };

  handle('connections:list', () => ({ ok: true, connections: getConnections() }));

  handle('connections:add', async (_e, arg) => {
    const name = String(arg?.name || '').trim();
    if (name.length < 1 || name.length > 60) return { ok: false, error: 'NAME_INVALID' };
    let url;
    try { url = normalizeStoreUrl(arg?.url); } catch { return { ok: false, error: 'URL_INVALID' }; }
    const list = getConnections();
    if (list.length >= 20) return { ok: false, error: 'TOO_MANY' };
    if (list.some((c) => c.url === url)) return { ok: false, error: 'DUPLICATE' };
    if (!(await checkReachable(url))) return { ok: false, error: 'UNREACHABLE' };
    const conn = { id: crypto.randomBytes(6).toString('hex'), name, url };
    saveConnections([...list, conn]);
    return { ok: true, connection: conn };
  });

  handle('connections:remove', (_e, id) => {
    const list = getConnections();
    const conn = list.find((c) => c.id === id);
    if (!conn) return { ok: false, error: 'NOT_FOUND' };
    const win = connectionWindows.get(conn.id);
    if (win && !win.isDestroyed()) win.close();
    saveConnections(list.filter((c) => c.id !== id));
    return { ok: true };
  });

  handle('connections:open', (_e, id) => {
    const conn = getConnections().find((c) => c.id === id);
    if (!conn) return { ok: false, error: 'NOT_FOUND' };
    openConnectionWindow(conn);
    return { ok: true };
  });

  handle('connections:scan', async () => {
    const found = await scanForServers(4000);
    return { ok: true, servers: found.map((a) => `http://${a}`) };
  });

  // "Change this register's mode": confirm in the main process (a page can't fake it), then drop the
  // saved host/client choice and relaunch into the setup window. Business data is untouched.
  handle('connections:reset-mode', async (event, labels) => {
    const clip = (v, d) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 400) : d);
    const parent = BrowserWindow.fromWebContents(event.sender) || undefined;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: [clip(labels?.confirm, 'Change mode'), clip(labels?.cancel, 'Cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: clip(labels?.title, 'Change host/client mode'),
      message: clip(labels?.message, 'This register will restart and ask you to choose host or client mode again. Your business data is not deleted.'),
    });
    if (response !== 0) return { ok: true, cancelled: true };
    // Forget only this register's host/client choice; saved store connections survive the switch.
    try {
      const keep = readConfig();
      if (keep && Array.isArray(keep.connections) && keep.connections.length) writeConfig({ connections: keep.connections });
      else if (fs.existsSync(CONFIG_PATH)) fs.unlinkSync(CONFIG_PATH);
    } catch (err) { return { ok: false, error: err?.message || 'ERROR' }; }
    if (serverProcess) { try { serverProcess.kill(); } catch {} }
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}

// Ctrl+Shift+O (only while an app window of this register is focused, not a system-wide hotkey):
// bring up Settings -> Store connections in the dashboard window, opening one if needed.
function attachConnectionsShortcut(win) {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.control && input.shift && !input.alt && String(input.key).toLowerCase() === 'o') {
      event.preventDefault();
      openConnectionsSettings();
    }
  });
}

function openConnectionsSettings() {
  const target = '/dashboard/settings?section=connections';
  const dash = BrowserWindow.getAllWindows().find((w) => {
    try { const u = new URL(w.webContents.getURL()); return u.origin === ownOrigin && u.pathname.startsWith('/dashboard'); } catch { return false; }
  });
  if (dash) {
    if (dash.isMinimized()) dash.restore();
    dash.focus();
    // Client-side navigation (react-router listens for popstate) so the dashboard keeps its state.
    dash.webContents.executeJavaScript(
      `history.pushState({}, '', ${JSON.stringify(target)}); window.dispatchEvent(new PopStateEvent('popstate'));`, true
    ).catch(() => {});
    return;
  }
  const win = new BrowserWindow({
    width: 1280, height: 800, title: 'OmniPOS', autoHideMenuBar: true, frame: false,
    icon: path.join(__dirname, '..', 'assets', 'posicon.ico'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, 'electron-preload.cjs') },
  });
  win.setMenu(null);
  attachConnectionsShortcut(win);
  win.webContents.setWindowOpenHandler(({ url }) =>
    openOutsideLinkExternally(win, url) ? { action: 'deny' } : { action: 'allow' });
  win.loadURL(`${ownOrigin}${target}`);
}
// === END STORE CONNECTIONS ===

function startLocalServer(config, onReady) {
  const serverPath = path.resolve(__dirname, '..', 'dist-server', 'server.js');
  const serverEnv = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || 'production',
    PORT: 3000,
    ELECTRON_RUN_AS_NODE: '1',
  };

  serverProcess = fork(serverPath, [], {
    env: serverEnv,
    stdio: ['inherit', 'pipe', 'pipe', 'ipc'],
  });

  let serverOutput = '';
  serverProcess.stdout?.on('data', (data) => {
    const str = data.toString();
    serverOutput += str;
    if (serverOutput.length > 10000) serverOutput = serverOutput.slice(-10000);
    console.log(`[Server]: ${str}`);
  });
  serverProcess.stderr?.on('data', (data) => {
    const str = data.toString();
    serverOutput += str;
    if (serverOutput.length > 10000) serverOutput = serverOutput.slice(-10000);
    console.error(`[Server Error]: ${str}`);
  });
  serverProcess.on('error', (err) => console.error('Failed to start server process:', err));
  serverProcess.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
    if (mainWindow && code !== 0 && code !== null) {
      mainWindow.loadURL(`data:text/html,<h2 style="font-family:sans-serif;padding:20px;color:#c00">Backend crashed (code ${code}). Please restart OmniPOS.</h2>`);
    }
  });

  const waitForServer = (port, host, timeoutMs) => {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const attempt = () => {
        const socket = new net.Socket();
        socket.on('connect', () => { socket.destroy(); resolve(); });
        socket.on('error', () => { socket.destroy(); retry(); });
        socket.on('timeout', () => { socket.destroy(); retry(); });
        const retry = () => {
          if (Date.now() - startTime > timeoutMs) reject(new Error('Timeout'));
          else setTimeout(attempt, 500);
        };
        socket.connect(port, host);
      };
      attempt();
    });
  };

  waitForServer(3000, '127.0.0.1', 60000)
    .then(onReady)
    .catch((err) => {
      console.error('Server failed to start:', err);
      mainWindow?.loadURL(`data:text/html,<h2 style="font-family:sans-serif;padding:20px;color:#c00">Server failed to start. Check logs in ${appDataDir}</h2>`);
    });
}

// --- Startup ---
app.on('ready', () => {
  registerConnectionsIpc();
  const config = readConfig();
  if (!config || !config.mode) {
    openSetupWindow();
  } else {
    launchMain(config);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    if (serverProcess) serverProcess.kill();
    app.quit();
  }
});

app.on('activate', () => {
  if (!mainWindow && !setupWindow) {
    const config = readConfig();
    if (!config || !config.mode) openSetupWindow();
    else launchMain(config);
  }
});
