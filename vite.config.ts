import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { visualWorkerBudgetPlugin } from './scripts/visualWorkerBudget';

// Excalidraw zh-CN 语言包增补插件（补齐官方 zh-CN 语言包中遗漏的 fontList、quickSearch、commandPalette 等词条）
function excalidrawLocalesPlugin() {
  const extraZhCn = {
    quickSearch: {
      placeholder: '快速搜索',
    },
    fontList: {
      badge: {
        old: '旧版',
      },
      sceneFonts: '当前画板已用字体',
      availableFonts: '可用字体',
      empty: '未找到匹配字体',
    },
    commandPalette: {
      title: '命令面板',
      shortcuts: {
        select: '选择',
        confirm: '确认',
        close: '关闭',
      },
      recents: '最近使用',
      search: {
        placeholder: '搜索菜单、命令及操作',
        noMatch: '未找到匹配命令...',
      },
      itemNotAvailable: '命令当前不可用...',
      shortcutHint: '快捷键：{{shortcut}}',
    },
    labels: {
      changeStroke: '更改描边颜色',
      changeBackground: '更改背景颜色',
      showFonts: '选择字体',
      more_options: '更多选项',
      arrowtypes: '箭头类型',
      arrowtype_sharp: '尖角箭头',
      arrowtype_round: '曲线箭头',
      arrowtype_elbowed: '折线箭头',
      clearCanvas: '清除画布',
      toggleGrid: '切换网格',
      loadScene: '从文件加载场景',
      theme: '主题',
      followUs: '关注我们',
      discordChat: 'Discord 社区',
      zoomToFitViewport: '缩放至适合视口',
      zoomToFitSelection: '缩放至适合所选',
      zoomToFit: '缩放以适应所有元素',
      installPWA: '安装 Excalidraw',
      autoResize: '启用文本自动调整大小',
      imageCropping: '图像裁剪',
      unCroppedDimension: '未裁剪尺寸',
      copyElementLink: '复制对象链接',
      linkToElement: '链接到对象',
      wrapSelectionInFrame: '将所选内容放入画框',
      link: {
        hint: '在此输入或粘贴链接',
        goToElement: '跳转至目标对象',
      },
      lineEditor: {
        editArrow: '编辑箭头',
      },
    },
    elementLink: {
      title: '链接到对象',
      desc: '点击画布上的图形或粘贴链接。',
      notFound: '在画布上未找到链接的对象。',
    },
    search: {
      title: '在画布中查找',
      noMatch: '未找到匹配项...',
      singleResult: '个结果',
      multipleResults: '个结果',
      placeholder: '在画布中查找文本...',
    },
    buttons: {
      copyLink: '复制链接',
      systemMode: '跟随系统',
    },
    element: {
      rectangle: '矩形',
      diamond: '菱形',
      ellipse: '椭圆',
      arrow: '箭头',
      line: '线条',
      freedraw: '自由书写',
      text: '文字',
      image: '图像',
      group: '编组',
      frame: '画框',
      magicframe: '线框图至代码',
      embeddable: '网页嵌入',
      selection: '所选项',
      iframe: '内嵌框架',
    },
    hints: {
      dismissSearch: '按 Escape 关闭搜索',
      arrowTool: '点击确定多个折点，拖动绘制单条线。再次按 {{arrowShortcut}} 切换箭头类型。',
      createFlowchart: '按住 CtrlOrCmd 并按方向键以创建流程图',
      enterCropEditor: '双击图像或按 Enter 开始裁剪',
      leaveCropEditor: '点击图像外部或按 Enter / Escape 完成裁剪',
    },
    shareDialog: {
      or: '或',
    },
    stats: {
      shapes: '图形',
      fullTitle: '画布与图形属性',
      generalStats: '常规统计',
      elementProperties: '图形属性',
    },
    toast: {
      copyToClipboardAsSvg: '已将 {{exportSelection}} 作为 SVG 复制到剪贴板\n({{exportColorScheme}})',
      elementLinkCopied: '对象链接已复制到剪贴板',
    },
  };

  const extraZhCnJson = JSON.stringify(extraZhCn);

  return {
    name: 'vite-plugin-excalidraw-locales',
    transform(code: string, id: string) {
      let modified = code;

      // 1. 匹配 dev 模式、prod 构建以及 .vite/deps 预编译缓存中的 zh-CN 语言模块，合并扩充词条
      if (id.includes('zh-CN-') || id.includes('zh-CN.json') || (id.includes('zh-CN') && (id.endsWith('.js') || id.includes('deps')))) {
        const regex = /export\s*\{[^}]*?\b([a-zA-Z0-9_$]+)\s+as\s+default[^}]*?\}/;
        const match = modified.match(regex);
        if (match) {
          const defaultExportName = match[1];
          const patchCode = `
const _extraLocales = ${extraZhCnJson};
function _deepMergeLocales(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key] || typeof target[key] !== 'object') {
        target[key] = {};
      }
      _deepMergeLocales(target[key], source[key]);
    } else {
      target[key] = source[key];
    }
  }
  return target;
}
_deepMergeLocales(${defaultExportName}, _extraLocales);
`;
          modified = modified.replace(regex, `${patchCode}\n$&`);
        }
      }

      // 2. 针对 Excalidraw 核心 chunk、index 及预编译依赖中的 fallback 英文词条进行深度兜底替换
      if (id.includes('excalidraw') || id.includes('chunk-')) {
        modified = modified
          .replaceAll('"In this scene"', '"当前画板已用字体"')
          .replaceAll("'In this scene'", "'当前画板已用字体'")
          .replaceAll('"Available fonts"', '"全部可用字体"')
          .replaceAll("'Available fonts'", "'全部可用字体'")
          .replaceAll('"Quick search"', '"快速搜索"')
          .replaceAll("'Quick search'", "'快速搜索'")
          .replaceAll('"No fonts found"', '"未找到匹配字体"')
          .replaceAll("'No fonts found'", "'未找到匹配字体'")
          .replaceAll('"Show font picker"', '"选择字体"')
          .replaceAll("'Show font picker'", "'选择字体'");
      }

      return modified !== code ? modified : null;
    },
  };
}

// 🔴 N10.1：构建模块来源清单插件——每个 chunk 输出其包含的包来源
// （node_modules → 真实包名，含 pnpm .pnpm 布局解析；src → 项目内路径前缀）。
// 预算门禁按来源追踪禁止库：chunk 改名/合并仍能检出（不依赖文件名黑名单）。
function moduleSourceManifestPlugin(): import('vite').Plugin {
  return {
    name: 'noteboard-module-source-manifest',
    generateBundle(_options: unknown, bundle: Record<string, unknown>) {
      // 从模块 id 提取真实包名：取路径中最后一个 node_modules/<pkg> 段
      // （pnpm 的 .pnpm/<pkg>@<v>/node_modules/<pkg>/ 布局下最后一段才是真实包名）
      const packageNameOf = (id: string): string => {
        const matches = [...id.matchAll(/node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/g)];
        if (matches.length === 0) {
          // 项目内模块：以 src 下的路径前缀（保留两级目录即可定位来源特性）
          const normalized = id.replace(/\\/g, '/');
          const srcIdx = normalized.indexOf('/src/');
          if (srcIdx >= 0) return normalized.slice(srcIdx + 1, srcIdx + 1 + 60);
          return normalized.split('/').slice(-2).join('/');
        }
        return matches[matches.length - 1][1];
      };
      const report: Record<string, { packages: string[] }> = {};
      for (const [fileName, chunkUnknown] of Object.entries(bundle)) {
        const chunk = chunkUnknown as { type?: string; moduleIds?: string[] };
        if (chunk.type !== 'chunk') continue;
        const packages = [...new Set((chunk.moduleIds ?? []).map(packageNameOf))].sort();
        report[fileName] = { packages };
      }
      this.emitFile({
        type: 'asset',
        fileName: '.module-sources.json',
        source: JSON.stringify(report, null, 1),
      });
    },
  };
}

/** 网页构建时预压缩文本资源，部署后直接发送压缩副本，避免每次请求占用服务端 CPU。 */
function webCompressionPlugin(): import('vite').Plugin {
  return {
    name: 'noteboard-web-compression',
    apply: 'build',
    // 等 Vite 完成动态导入预载与 CSS 注入后再压缩，副本必须与最终输出逐字节一致。
    generateBundle: { order: 'post', handler(_options, bundle) {
      for (const [fileName, item] of Object.entries(bundle)) {
        // 小资源与字体、图片不重复压缩；点目录清单也不作为公开资源处理。
        if (fileName.startsWith('.') || !/\.(js|css|json|svg)$/.test(fileName)) continue;
        const bytes = Buffer.from(item.type === 'chunk' ? item.code : item.source);
        if (bytes.length < 1024) continue;
        // Brotli 使用中等压缩级别控制构建耗时；gzip 兼容普通 HTTP 和较旧客户端。
        const compressed = {
          br: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }),
          gz: gzipSync(bytes),
        };
        for (const [extension, source] of Object.entries(compressed)) {
          if (source.length < bytes.length) this.emitFile({ type: 'asset', fileName: `${fileName}.${extension}`, source });
        }
      }
    } },
  };
}

// Vite 配置
// 注意：base 必须是 './'，Tauri 用 file:// 加载
// 标准 Tauri 开发命令会注入系统分配的空闲端口；直接运行 Vite 时才使用 1421 作为起始端口。
const configuredDevPort = Number.parseInt(process.env.NOTEBOARD_DEV_PORT ?? '', 10);
const hasAllocatedDevPort = Number.isInteger(configuredDevPort)
  && configuredDevPort > 0
  && configuredDevPort <= 65535;
const devPort = hasAllocatedDevPort ? configuredDevPort : 1421;

// Vite 与 Tauri 必须使用同一端口；动态端口已预选完成时禁止 Vite 静默切换，避免 WebView 串线。
export default defineConfig(({ command, mode }) => ({
  base: './',
  plugins: [react(), tailwindcss(), excalidrawLocalesPlugin(), moduleSourceManifestPlugin(), ...(mode === 'web' ? [webCompressionPlugin()] : [])],
  define: {
    // 构建目标平台（Tauri CLI 运行 beforeDev/BuildCommand 时注入 TAURI_ENV_PLATFORM），供前端同步判定桌面/移动端
    // 网页构建使用独立运行时；原生构建仍由 Tauri 注入真实平台。
    __NB_TARGET_PLATFORM__: JSON.stringify(mode === 'web' ? 'web' : process.env.TAURI_ENV_PLATFORM ?? ''),
    // 仅开发服务器允许 ?mock=1 浏览器预览（模拟 Tauri IPC）；生产构建中该分支被常量折叠移除
    __NB_DEV_MOCK__: JSON.stringify(command === 'serve'),
    'process.env.IS_PREACT': JSON.stringify('false'),
    'process.env': {},
  },
  resolve: {
    alias: {
      // 仅网页模式替换系统接口，避免改变 Windows / Android 的原生调用和界面行为。
      ...(mode === 'web' ? Object.fromEntries([
        '@tauri-apps/api/core', '@tauri-apps/api/window', '@tauri-apps/api/webview',
        '@tauri-apps/api/event', '@tauri-apps/api/app', '@tauri-apps/plugin-dialog', '@tauri-apps/plugin-fs',
      ].map((name) => [name, fileURLToPath(new URL('./src/web/runtime.ts', import.meta.url))])) : {}),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // 依赖预构建只从应用入口爬取；未配置时 Vite 会把 src-tauri/target、test-results、tools 下的 HTML 也当入口扫描
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    // 网页开发时复用生产 HTTP 服务；部署镜像直接由该服务托管静态文件。
    ...(mode === 'web' ? { proxy: { '/api': 'http://127.0.0.1:3000' } } : {}),
    host: '127.0.0.1',
    port: devPort,
    strictPort: hasAllocatedDevPort,
    watch: {
      // 🔴 src-tauri/target 有数万个构建产物，chokidar 初次遍历会长时间占住事件循环，
      //    把依赖扫描从约 1 秒拖到 100 秒以上（冷启动白屏近 2 分钟）；且 cargo 编译期间持续写入会刷屏触发事件。
      //    这些目录均不被前端 import；Rust 侧的改动监听由 Tauri CLI 自行负责。
      ignored: ['**/src-tauri/**', '**/test-results/**', '**/tools/**', '**/dist/**'],
    },
  },
  build: {
    target: 'chrome105', // WebView2 基线
    // 🔴 N10.1：输出构建模块清单（dist/.vite/manifest.json）——预算门禁按模块
    //    来源追踪禁止库（不依赖 chunk 文件名；改名/合并仍能检出）
    manifest: true,
    rollupOptions: {
      output: {
        // 手动分包只接收明确归组的模块；共享 UI 依赖不能被画板/图表包吸走，反向拖入首屏。
        onlyExplicitManualChunks: true,
        // 🔴 S05：函数式 manualChunks，切断「入口为拿 React 归宿而静态 import 重 chunk」的回边。
        //   之前的对象形式把 react/react-dom 卷进 excalidraw chunk（因为该包体积最大），
        //   导致入口静态闭包含整个 1.1 MiB 画板库。
        //   规则：
        //   1. react 全家桶 → vendor-react（入口必需的公共依赖，单独小 chunk）
        //   2. mermaid/excalidraw/katex → 独立库 chunk（只含库自身代码，应用代码经动态 import 进入）
        //   3. 其余 node_modules 不归组（避免所有重库变成共有前置依赖）
        manualChunks(id) {
          // 🔴 Vite 的动态 import 预载辅助（__vite__preloadHelper）默认会被放进
          //    首个创建的 chunk——此处即 mermaid 重 chunk，导致入口为拿这一个函数
          //    静态 import 3 MiB 的图表运行时。显式归入入口必需的 vendor-react。
          if (id.includes('vite/preload-helper') || id.includes('\0commonjsHelpers')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules')) {
            // 🔴 dompurify 同时被 mermaid 与入口闭包（块级 HTML 渲染）静态依赖；
            //    不显式归组会被并进 mermaid 重 chunk，入口为拿它静态 import 整个图表运行时。
            if (/[\\/]dompurify[\\/]/.test(id)) return 'vendor-purify';
            if (id.includes('mermaid')) return 'mermaid';
            if (id.includes('@excalidraw') || id.includes('excalidraw')) return 'excalidraw';
            if (id.includes('katex')) return 'katex';
            // 必须匹配独立 npm 包，不能把 @tiptap/react、@floating-ui/react-dom 当作 React 核心。
            if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'vendor-react';
          }
          return undefined;
        },
      },
    },
  },
  worker: {
    format: 'es', // sectionWorker 需要
    // Worker 单独构建，必须在自己的完整模块图上执行依赖与体积检查。
    plugins: () => [visualWorkerBudgetPlugin()],
  },
}));
