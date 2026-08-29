import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

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

// Vite 配置
// 注意：base 必须是 './'，Tauri 用 file:// 加载
// 标准 Tauri 开发命令会注入系统分配的空闲端口；直接运行 Vite 时才使用 1421 作为起始端口。
const configuredDevPort = Number.parseInt(process.env.NOTEBOARD_DEV_PORT ?? '', 10);
const hasAllocatedDevPort = Number.isInteger(configuredDevPort)
  && configuredDevPort > 0
  && configuredDevPort <= 65535;
const devPort = hasAllocatedDevPort ? configuredDevPort : 1421;

// Vite 与 Tauri 必须使用同一端口；动态端口已预选完成时禁止 Vite 静默切换，避免 WebView 串线。
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), excalidrawLocalesPlugin()],
  define: {
    'process.env.IS_PREACT': JSON.stringify('false'),
    'process.env': {},
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: devPort,
    strictPort: hasAllocatedDevPort,
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
