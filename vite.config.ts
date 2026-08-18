import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Vite 配置
// 注意：base 必须是 './'，Tauri 用 file:// 加载
// server.port 必须与 tauri.conf.json 的 devUrl 一致，且 strictPort: true
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
    'process.env': {},
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: 'chrome105', // WebView2 基线
    rollupOptions: {
      output: {
        manualChunks: {
          katex: ['katex'],
          mermaid: ['mermaid'],
          excalidraw: ['@excalidraw/excalidraw'],
          highlight: ['lowlight', 'highlight.js'],
        },
      },
    },
  },
  worker: {
    format: 'es', // sectionWorker 需要
  },
});
