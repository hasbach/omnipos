import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";

declare module 'express-session' {
  interface SessionData {
    tenantId: number | string;
    tenantName: string;
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- EARLY LOGGING SETUP ---
let logPath = null;
if (process.env.NODE_ENV === 'production' || process.env.ELECTRON_RUN_AS_NODE) {
  const dataDir = process.env.APPDATA || (process.platform === 'darwin' ? path.join(process.env.HOME || '', 'Library', 'Application Support') : path.join(process.env.HOME || '', '.config'));
  const appDataDir = path.join(dataDir, 'OmniPOS');
  if (!fs.existsSync(appDataDir)) {
    try { fs.mkdirSync(appDataDir, { recursive: true }); } catch (e) {}
  }
  logPath = path.join(appDataDir, 'server-error.log');
  try {
    if (!fs.existsSync(logPath)) {
      fs.writeFileSync(logPath, `[${new Date().toISOString()}] Log file created\n`);
    }
  } catch (e) {}
}

const logToFile = (msg: string) => {
  if (logPath) {
    try {
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
    } catch (e) {}
  }
};

// Redirect console immediately
const originalLog = console.log;
const originalError = console.error;
console.log = (...args) => {
  logToFile(`LOG: ${args.join(' ')}`);
  originalLog.apply(console, args);
};
console.error = (...args) => {
  logToFile(`ERROR: ${args.join(' ')}`);
  originalError.apply(console, args);
};

process.on('uncaughtException', (err) => {
  console.error(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error(`UNHANDLED REJECTION: ${reason}`);
});

console.log("Server process started");
// --- END EARLY LOGGING ---

import { startDiscoveryBeacon } from './server/discovery.js';

// Dynamic imports for external modules to catch resolution errors
const express = (await import("express")).default;
const Database = (await import("better-sqlite3")).default;
const { WebSocketServer, WebSocket } = await import("ws");
const session = (await import("express-session")).default;
const SqliteStoreFactory = (await import("connect-sqlite3")).default;
const SqliteStore = SqliteStoreFactory(session);
const bcrypt = (await import("bcryptjs")).default;
const dotenv = (await import("dotenv")).default;
dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = 3000;

app.use(express.json());

// Middleware to check authentication
const authenticate = (req: any, res: any, next: any) => {
  if (req.session.tenantId) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
};

// WebSocket Broadcast
function broadcast(data: any, tenantId: number) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client: any) => {
    if (client.readyState === WebSocket.OPEN && client.tenantId === tenantId) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws: any, req: http.IncomingMessage) => {
  console.log('Client connected to real-time sync');
  ws.send(JSON.stringify({ type: 'SYNC_CONNECTED', timestamp: new Date().toISOString() }));
  
  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'IDENTIFY') {
        ws.tenantId = data.tenantId;
        ws.terminalId = data.terminalId || `term-${Math.random().toString(36).substring(2, 9)}`;
        ws.isMonitor = data.isMonitor || false;
        
        // Notify others that a new terminal is online
        if (!ws.isMonitor) {
          broadcast({ type: 'TERMINAL_ONLINE', terminalId: ws.terminalId }, ws.tenantId);
        }
      }
      
      if (data.type === 'CART_UPDATE' && ws.tenantId) {
        broadcast({ 
          type: 'REMOTE_CART_UPDATE', 
          terminalId: ws.terminalId, 
          cart: data.cart,
          user: data.user,
          total: data.total
        }, ws.tenantId);
      }
    } catch (e) {}
  });

  ws.on('close', () => {
    if (ws.tenantId && ws.terminalId && !ws.isMonitor) {
      broadcast({ type: 'TERMINAL_OFFLINE', terminalId: ws.terminalId }, ws.tenantId);
    }
  });
});

import { db, sessionsDir, logAction } from './server/db.js';
import { setupRoutes } from './server/routes.js';


app.use(express.json());

app.use(session({
  store: new SqliteStore({
    db: 'sessions.db',
    dir: sessionsDir,
    concurrentDB: true
  }),
  secret: process.env.SESSION_SECRET || 'omnipos-secret-key-fallback',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false,
    sameSite: 'lax',
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

setupRoutes(app, wss, broadcast, authenticate);

// Vite middleware for development
if (process.env.NODE_ENV !== "production") {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
  // SPA fallback for development
  app.use('*', async (req, res, next) => {
    const url = req.originalUrl;
    if (url.startsWith('/api')) return next();
    try {
      let template = await vite.transformIndexHtml(url, `
        <!DOCTYPE html>
        <html lang="en">
          <head>
            <meta charset="UTF-8" />
            <link rel="icon" type="image/svg+xml" href="/vite.svg" />
            <meta name="viewport" content="width=device-width, initial-scale=1.0" />
            <title>OmniPOS</title>
          </head>
          <body>
            <div id="root"></div>
            <script type="module" src="/src/main.tsx"></script>
          </body>
        </html>
      `);
      res.status(200).set({ 'Content-Type': 'text/html' }).end(template);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
} else {
  const buildPath = path.resolve(__dirname, fs.existsSync(path.join(__dirname, "build")) ? "build" : "../build");
  console.log(`Production mode: serving static files from ${buildPath}`);
  if (!fs.existsSync(buildPath)) {
    console.error(`CRITICAL: build folder not found at ${buildPath}`);
  }
  app.use(express.static(buildPath));
  app.get("*", (req, res) => {
    res.sendFile(path.join(buildPath, "index.html"));
  });
}

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please close other applications using this port.`);
  } else {
    console.error(`Server error: ${err.message}`);
  }
  process.exit(1);
});

import { startSyncEngine } from './server/sync.js';

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startDiscoveryBeacon(PORT);
  
  // Start the background offline-first cloud sync
  startSyncEngine();
});
