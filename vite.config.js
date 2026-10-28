import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  // 部署在 /chat-app/ 这类子路径下，用相对路径避免写死
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    // 单页应用：产物可以直接丢进 Caddy 静态目录
    rollupOptions: {
      input: { index: resolve('index.html') },
    },
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5180,
    proxy: {
      // 本地开发时把面板与网关请求转发给真实 sub2api
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/v1': { target: 'http://localhost:8080', changeOrigin: true },
      '/v1beta': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
})
