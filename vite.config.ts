import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const page = (name: string) => fileURLToPath(new URL(name, import.meta.url))

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Tauri prints its own output; keep it visible.
  clearScreen: false,
  server: {
    // tauri.conf.json devUrl is fixed to :5173.
    port: 5173,
    strictPort: true,
    proxy: {
      // Web UI development against a running kiosk app (embedded server, CONTRACT §4).
      // changeOrigin keeps Host consistent; SSE (/api/events) streams through as-is.
      '/api': {
        target: 'http://127.0.0.1:7380',
        changeOrigin: true,
        ws: false,
      },
    },
  },
  build: {
    rolldownOptions: {
      input: {
        main: page('./index.html'),
        remote: page('./remote.html'),
      },
      output: {
        codeSplitting: {
          // @tauri-apps in a chunk of its own. The web UI shares src/utils/backend.ts, whose
          // lazy Tauri imports must never resolve into the kiosk's main chunk (that would
          // start the kiosk app inside the web UI).
          // React gets a named chunk of its own: with lazily loaded widgets (src/widgets/index.ts)
          // the automatic split would otherwise name the shared React chunk after some icon.
          groups: [
            { name: 'tauri', test: /node_modules[\\/]@tauri-apps[\\/]/ },
            { name: 'react', test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/ },
          ],
        },
      },
    },
  },
})
