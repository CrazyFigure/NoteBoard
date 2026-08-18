import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Vitest 配置
// jsdom 环境用于读取 CSS 变量（对比度测试）
// 路径别名与 vite.config.ts 对齐
//
// 测试模式下不加载 @vitejs/plugin-react：
// 它在 vitest 下对被内联的依赖（如 @tiptap/react）注入 Fast Refresh preamble
// 会报 "can't detect preamble"，导致无法测试含 React NodeView 的模块。
// tsconfig 的 jsx: react-jsx 让 esbuild 的 automatic runtime 接管 JSX 转换即可。
export default defineConfig({
  plugins: [process.env.VITEST ? null : react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    css: true, // 加载 CSS 用于对比度测试
  },
});
