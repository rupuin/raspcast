import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 3141,
    proxy: {
      '/auth': 'http://localhost:5173',
      '/history': 'http://localhost:5173',
      '/ws': {
        target: 'ws://localhost:5173',
        ws: true,
      },
    },
  },
})
