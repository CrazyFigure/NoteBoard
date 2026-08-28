// NoteBoard 文件格式优雅图标体系
// 集中管理资源管理器树、标签页及其他视图中的文件图标与精致色彩
// 支持常见/特殊图片、画板、Markdown、代码、数据文件及各类配置等

import type { ReactNode } from 'react';
import {
  FileText,
  File,
  Database,
  Braces,
  FileCode,
  CodeXml,
  PencilRuler,
  FileQuestion,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Film,
  AppWindow,
  Shapes,
  SlidersHorizontal,
  Terminal,
  Table,
  Archive,
  Music,
  Video,
  Network,
  Workflow,
  GitMerge,
  Layout,
} from 'lucide-react';
import { extFromPath } from '../../core/docKind';

export interface FileIconOptions {
  size?: number;
  isDir?: boolean;
  isOpen?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * 根据文件路径与状态获取优雅的文件/文件夹图标
 */
export function getExplorerFileIcon(
  fileNameOrPath: string,
  options: FileIconOptions = {},
): ReactNode {
  const { size = 14, isDir = false, isOpen = false, className, style } = options;
  const iconProps = {
    size,
    className,
    style: { flexShrink: 0, ...style },
  };

  // 1. 文件夹图标渲染（温暖琥珀金黄色）
  if (isDir) {
    if (isOpen) {
      return <FolderOpen {...iconProps} color="#f59e0b" />;
    }
    return <Folder {...iconProps} color="#f59e0b" />;
  }

  const ext = extFromPath(fileNameOrPath);

  // 2. 根据文件扩展名返回专属图标与调优配色
  switch (ext) {
    // ── Markdown 笔记（NoteBoard 核心，品牌蓝）──
    case 'md':
    case 'markdown':
      return <FileText {...iconProps} color="var(--editor-accent, #3b82f6)" />;

    // ── 思维导图与大纲（XMind / MindMap，活力珊瑚橙）──
    case 'mindmap':
    case 'xmind':
    case 'mm':
      return <Network {...iconProps} color="#f97316" />;

    // ── Draw.io / 架构流程图（经典科技橙红）──
    case 'drawio':
    case 'dio':
      return <Layout {...iconProps} color="#ea580c" />;

    // ── 多维表格（多维表格风格蓝色）──
    case 'bitable':
    case 'table':
      return <Table {...iconProps} color="#2563eb" />;

    // ── Mermaid 流程与时序图表（现代青绿）──
    case 'mmd':
    case 'mermaid':
      return <Workflow {...iconProps} color="#00bfb2" />;

    // ── UML / PlantUML 建模图（优雅洋紫）──
    case 'puml':
    case 'plantuml':
    case 'iuml':
    case 'uml':
      return <GitMerge {...iconProps} color="#a855f7" />;

    // ── 自由画板 / 白板（艺术品红与紫）──
    case 'board':
    case 'canvas':
    case 'excalidraw':
      return <PencilRuler {...iconProps} color="var(--accent-strong, #8b5cf6)" />;

    // ── 常见位图图片格式（翡翠绿）──
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'jpe':
    case 'jfif':
    case 'bmp':
    case 'dib':
    case 'avif':
      return <ImageIcon {...iconProps} color="#10b981" />;

    // ── 动态图片格式 GIF / APNG（动态玫粉）──
    case 'gif':
    case 'apng':
      return <Film {...iconProps} color="#f43f5e" />;

    // ── 现代 Web 图片格式 WEBP（科技青蓝）──
    case 'webp':
      return <ImageIcon {...iconProps} color="#06b6d4" />;

    // ── 应用/系统图标格式 ICO / CUR（琥珀金黄）──
    case 'ico':
    case 'cur':
      return <AppWindow {...iconProps} color="#f59e0b" />;

    // ── 矢量图形格式 SVG（优雅橙）──
    case 'svg':
      return <Shapes {...iconProps} color="#f97316" />;

    // ── 数据库与 SQL（钴蓝）──
    case 'sql':
    case 'sqlite':
    case 'db':
      return <Database {...iconProps} color="#0284c7" />;

    // ── JSON 数据契约（暖金黄）──
    case 'json':
    case 'jsonc':
    case 'json5':
      return <Braces {...iconProps} color="#eab308" />;

    // ── YAML 配置（森林翠绿）──
    case 'yaml':
    case 'yml':
      return <FileCode {...iconProps} color="#16a34a" />;

    // ── XML 与标记语言（珊瑚橙红）──
    case 'xml':
    case 'xsd':
    case 'rss':
    case 'atom':
    case 'html':
    case 'htm':
      return <CodeXml {...iconProps} color="#ea580c" />;

    // ── 样式表（CSS 蓝/紫）──
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return <FileCode {...iconProps} color="#2563eb" />;

    // ── JavaScript / TypeScript 前端代码 ──
    case 'js':
    case 'mjs':
    case 'cjs':
      return <FileCode {...iconProps} color="#eab308" />;
    case 'ts':
    case 'mts':
    case 'cts':
      return <FileCode {...iconProps} color="#3178c6" />;
    case 'jsx':
    case 'tsx':
      return <FileCode {...iconProps} color="#06b6d4" />;

    // ── 后端与系统级编程语言 ──
    case 'rs':
      return <FileCode {...iconProps} color="#ea580c" />;
    case 'py':
    case 'pyw':
      return <FileCode {...iconProps} color="#3b82f6" />;
    case 'go':
      return <FileCode {...iconProps} color="#00add8" />;
    case 'java':
    case 'kt':
      return <FileCode {...iconProps} color="#f97316" />;
    case 'c':
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'h':
    case 'hpp':
      return <FileCode {...iconProps} color="#6366f1" />;

    // ── 脚本与终端指令 ──
    case 'sh':
    case 'bash':
    case 'zsh':
    case 'bat':
    case 'cmd':
    case 'ps1':
      return <Terminal {...iconProps} color="#10b981" />;

    // ── 表格与数据表 ──
    case 'csv':
    case 'tsv':
    case 'xlsx':
    case 'xls':
      return <Table {...iconProps} color="#10b981" />;

    // ── 配置文件与系统环境（控制滑块，石板灰）──
    case 'ini':
    case 'conf':
    case 'cfg':
    case 'env':
    case 'properties':
    case 'toml':
      return <SlidersHorizontal {...iconProps} color="#64748b" />;

    // ── 纯文本与运行日志（极简中性灰）──
    case 'txt':
    case 'log':
    case 'text':
      return <FileText {...iconProps} color="#64748b" />;

    // ── 压缩包文件 ──
    case 'zip':
    case 'tar':
    case 'gz':
    case '7z':
    case 'rar':
      return <Archive {...iconProps} color="#a855f7" />;

    // ── 音频与视频媒体 ──
    case 'mp3':
    case 'wav':
    case 'flac':
    case 'aac':
    case 'ogg':
      return <Music {...iconProps} color="#ec4899" />;
    case 'mp4':
    case 'mkv':
    case 'avi':
    case 'mov':
    case 'webm':
      return <Video {...iconProps} color="#8b5cf6" />;

    // ── 默认与未知文件 ──
    default:
      if (!ext) {
        return <File {...iconProps} color="var(--explorer-text-muted, #94a3b8)" />;
      }
      return <FileQuestion {...iconProps} color="var(--explorer-text-muted, #94a3b8)" />;
  }
}
