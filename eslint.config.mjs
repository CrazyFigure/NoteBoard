import eslint from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

// ESLint 9 使用 Flat Config；这里集中定义项目源码、测试和 Node 脚本的检查边界。
const nodeGlobals = {
  AbortSignal: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  process: 'readonly',
  setTimeout: 'readonly',
};

export default [
  {
    // 构建产物、依赖和 Rust 工程不属于前端 JavaScript 静态检查范围。
    ignores: ['dist/**', 'node_modules/**', 'src-tauri/**', 'coverage/**'],
  },
  {
    // JavaScript 配置和脚本使用 ESLint 核心推荐规则，并声明 Node 运行时全局变量。
    files: ['**/*.{js,mjs,cjs}'],
    ...eslint.configs.recommended,
    languageOptions: {
      ...eslint.configs.recommended.languageOptions,
      globals: nodeGlobals,
    },
  },
  {
    // TypeScript 由 typescript-eslint 解析器处理，启用其不依赖类型信息的推荐规则。
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...eslint.configs.recommended.rules,
      ...tseslint.configs['flat/recommended'][1].rules,
      ...tseslint.configs['flat/recommended'][2].rules,
      // 下划线前缀表示刻意忽略的参数或解构字段，常用于清理第三方运行时状态。
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
    },
  },
];
