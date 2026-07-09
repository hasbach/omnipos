import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.ico', 'apple-touch-icon.png', 'masked-icon.svg'],
      manifest: {
        name: 'OmniPOS Live Monitor',
        short_name: 'OmniPOS',
        description: 'Real-time store monitoring dashboard',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    }),
    {
      name: 'rename-html',
      enforce: 'post',
      generateBundle(options, bundle) {
        if (bundle['monitor.html']) {
          bundle['index.html'] = bundle['monitor.html'];
          bundle['index.html'].fileName = 'index.html';
          delete bundle['monitor.html'];
        }
      }
    }
  ],
  define: {
    // Flag to tell the React app it's running in Web Mode
    'import.meta.env.VITE_WEB_MODE': JSON.stringify('true')
  },
  build: {
    outDir: 'dist-monitor',
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, 'monitor.html')
    }
  }
});
