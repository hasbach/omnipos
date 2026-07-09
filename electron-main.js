import { app, BrowserWindow, ipcMain } from 'electron';
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
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
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

  mainWindow.setMenuBarVisibility(false);
  mainWindow.setMenu(null);

  // === AUTO-UPDATER SETUP ===
  // Helper to push status events to the renderer
  const sendStatus = (event, payload = {}) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', { event, ...payload });
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

  // IPC: renderer requests check
  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdates());
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

  // Force all child windows (e.g. dashboard) to be frameless
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
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
  });
}

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
  const config = readConfig();
  if (!config) {
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
    if (!config) openSetupWindow();
    else launchMain(config);
  }
});
