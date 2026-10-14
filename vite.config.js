import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径产物：可直接部署到任意静态托管的根目录或子路径（GitHub Pages / OSS / Nginx 子目录）
  base: './',
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    outDir: 'dist',
    assetsDir: 'assets',
  },
  server: { port: 5173, strictPort: false },
  preview: { port: 4173, strictPort: true },
});
