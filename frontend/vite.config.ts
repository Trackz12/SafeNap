import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// TLS para acesso externo é feito pelo Tailscale Serve (certificado valido);
// por isso o dev server roda em HTTP simples localmente.
export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ['.ts.net'],
    proxy: {
      '/ws': {
        target: 'ws://localhost:8000',
        ws: true
      },
      '/api': {
        target: 'http://localhost:8000'
      }
    }
  },
  build: {
    chunkSizeWarningLimit: 1000,
  }
})
