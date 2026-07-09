import dgram from 'dgram';
import os from 'os';

const DISCOVERY_PORT = 47777;
const BEACON_INTERVAL_MS = 3000;
const BEACON_PREFIX = 'OMNIPOS_SERVER:';

function getLocalIPs(): string[] {
  const interfaces = os.networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push(addr.address);
      }
    }
  }
  return ips;
}

export function startDiscoveryBeacon(port: number = 3000) {
  const socket = dgram.createSocket('udp4');

  socket.bind(() => {
    socket.setBroadcast(true);
    const ips = getLocalIPs();
    console.log(`[Discovery] Broadcasting beacon from ${ips.join(', ')} on UDP port ${DISCOVERY_PORT}`);

    const sendBeacon = () => {
      const message = Buffer.from(`${BEACON_PREFIX}${ips[0] || '127.0.0.1'}:${port}`);
      socket.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
        if (err) console.error('[Discovery] Beacon send error:', err.message);
      });
    };

    sendBeacon();
    setInterval(sendBeacon, BEACON_INTERVAL_MS);
  });

  socket.on('error', (err) => {
    console.error('[Discovery] Socket error:', err.message);
  });

  return socket;
}

export function scanForServers(timeoutMs = 4000): Promise<string[]> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const found: string[] = [];

    socket.bind(DISCOVERY_PORT, () => {
      socket.setBroadcast(true);
    });

    socket.on('message', (msg) => {
      const str = msg.toString();
      if (str.startsWith(BEACON_PREFIX)) {
        const address = str.slice(BEACON_PREFIX.length);
        if (!found.includes(address)) {
          found.push(address);
        }
      }
    });

    socket.on('error', () => {});

    setTimeout(() => {
      socket.close();
      resolve(found);
    }, timeoutMs);
  });
}
