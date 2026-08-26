// NoteBoard 代码与纯文本编辑器顶部操作栏
// 适用于 JSON, TXT, XML, YAML, SQL, LOG, INI 等全部代码与纯文本格式
// 提供撤销/重做、JSON 专属格式化/压缩/校验多级菜单、文本大小写转换、视图辅助设置与搜索替换

import React, { useState } from 'react';
import {
  Undo2,
  Redo2,
  Braces,
  CodeXml,
  CaseSensitive,
  WrapText,
  ListOrdered,
  Eye,
  Search,
  Replace,
  Sparkles,
  CheckCircle2,
  Minimize2,
  Maximize2,
} from 'lucide-react';
import {
  ToolbarButton,
  ToolbarDivider,
  ToolbarDropdown,
  ToolbarDropdownItem,
} from './ToolbarComponents';
import {
  undoDocumentHistory,
  redoDocumentHistory,
  useDocumentHistory,
} from '../history/documentHistory';
import {
  handleExpandJson,
  handleMinifyJson,
  handleValidateJson,
  handleFormatXml,
} from '../editor-code/jsonOps';
import { handleTransformCase } from './textOps';
import { getEditorView } from '../editor-code/CodeEditor';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSearchStore } from '../../stores/searchStore';
import type { LanguageId } from '../../core/ipc/types';

interface CodeToolbarProps {
  docKey: string;
  language?: string;
}

export function CodeToolbar({ docKey, language }: CodeToolbarProps) {
  const lang = (language ?? 'plaintext') as LanguageId;
  const isJson = lang === 'json';
  const { canUndo, canRedo } = useDocumentHistory(docKey);

  // 下拉菜单开闭状态
  const [jsonDropdownOpen, setJsonDropdownOpen] = useState(false);
  const [textDropdownOpen, setTextDropdownOpen] = useState(false);

  // 编辑器设置
  const { settings, setEditor } = useSettingsStore();
  const editorSettings = settings.editor;
  const { openSearch } = useSearchStore();

  // ── 获取 CodeMirror 实例 ──
  const getView = () => getEditorView();

  // ── JSON 操作分发 ──
  const onExpandJson = (scope: 'all' | 'selection', tabSize?: number) => {
    setJsonDropdownOpen(false);
    const view = getView();
    if (view) {
      handleExpandJson(view, { scope, tabSize, lang });
    }
  };

  const onMinifyJson = (scope: 'all' | 'selection') => {
    setJsonDropdownOpen(false);
    const view = getView();
    if (view) {
      handleMinifyJson(view, { scope, lang });
    }
  };

  const onValidateJson = (scope: 'all' | 'selection') => {
    setJsonDropdownOpen(false);
    const view = getView();
    if (view) {
      handleValidateJson(view, { scope, lang });
    }
  };

  // ── 文本转换分发 ──
  const onTransformCase = (mode: 'upper' | 'lower' | 'title') => {
    setTextDropdownOpen(false);
    const view = getView();
    if (view) {
      handleTransformCase(view, mode);
    }
  };

  // ── XML 格式化 ──
  const onFormatXml = (scope: 'all' | 'selection') => {
    setTextDropdownOpen(false);
    const view = getView();
    if (view) {
      handleFormatXml(view, { scope });
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2, overflow: 'visible', flex: 1 }}>
      {/* ── 历史操作组 ── */}
      <ToolbarButton
        icon={<Undo2 size={15} strokeWidth={2.2} />}
        title="撤销"
        shortcut="Ctrl+Z"
        disabled={!canUndo}
        onClick={() => undoDocumentHistory(docKey)}
      />
      <ToolbarButton
        icon={<Redo2 size={15} strokeWidth={2.2} />}
        title="重做"
        shortcut="Ctrl+Y"
        disabled={!canRedo}
        onClick={() => redoDocumentHistory(docKey)}
      />

      <ToolbarDivider />

      {/* ── JSON 工具组（二级菜单） ── */}
      <ToolbarDropdown
        isOpen={jsonDropdownOpen}
        onOpenChange={setJsonDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<Braces size={15} />}
            label="JSON 工具"
            hasDropdown
            title="JSON 展开格式化、单行压缩与格式校验"
            active={isJson}
          />
        }
      >
        {/* 展开 / 格式化二级菜单 */}
        <ToolbarDropdownItem
          icon={<Maximize2 size={14} color="#3b82f6" />}
          label="JSON 展开 / 格式化"
          submenu={
            <>
              <ToolbarDropdownItem
                label="格式化全文 (2 空格缩进)"
                shortcut="Shift+Alt+F"
                onClick={() => onExpandJson('all', 2)}
              />
              <ToolbarDropdownItem
                label="格式化全文 (4 空格缩进)"
                onClick={() => onExpandJson('all', 4)}
              />
              <ToolbarDropdownItem
                label="格式化选中文本"
                onClick={() => onExpandJson('selection')}
              />
            </>
          }
        />

        {/* 压缩二级菜单 */}
        <ToolbarDropdownItem
          icon={<Minimize2 size={14} color="#8b5cf6" />}
          label="JSON 压缩 (Minify)"
          submenu={
            <>
              <ToolbarDropdownItem
                label="压缩全文为单行"
                shortcut="Shift+Alt+M"
                onClick={() => onMinifyJson('all')}
              />
              <ToolbarDropdownItem
                label="压缩选中文本"
                onClick={() => onMinifyJson('selection')}
              />
            </>
          }
        />

        {/* 校验二级菜单 */}
        <ToolbarDropdownItem
          icon={<CheckCircle2 size={14} color="#10b981" />}
          label="JSON 格式校验"
          submenu={
            <>
              <ToolbarDropdownItem
                label="校验全文语法"
                shortcut="Shift+Alt+V"
                onClick={() => onValidateJson('all')}
              />
              <ToolbarDropdownItem
                label="校验选中文本"
                onClick={() => onValidateJson('selection')}
              />
            </>
          }
        />
      </ToolbarDropdown>

      {/* ── 文本与代码增强工具组（二级菜单） ── */}
      <ToolbarDropdown
        isOpen={textDropdownOpen}
        onOpenChange={setTextDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<Sparkles size={15} />}
            label="文本工具"
            hasDropdown
            title="大小写转换与代码格式化"
          />
        }
      >
        {/* 大小写转换二级菜单 */}
        <ToolbarDropdownItem
          icon={<CaseSensitive size={14} />}
          label="大小写转换"
          submenu={
            <>
              <ToolbarDropdownItem
                label="转换为全部大写 (UPPERCASE)"
                onClick={() => onTransformCase('upper')}
              />
              <ToolbarDropdownItem
                label="转换为全部小写 (lowercase)"
                onClick={() => onTransformCase('lower')}
              />
              <ToolbarDropdownItem
                label="转换为词首大写 (Title Case)"
                onClick={() => onTransformCase('title')}
              />
            </>
          }
        />

        {/* XML 格式化 */}
        <ToolbarDropdownItem
          icon={<CodeXml size={14} />}
          label="XML 格式化"
          submenu={
            <>
              <ToolbarDropdownItem
                label="格式化全文 XML"
                onClick={() => onFormatXml('all')}
              />
              <ToolbarDropdownItem
                label="格式化选中文本"
                onClick={() => onFormatXml('selection')}
              />
            </>
          }
        />
      </ToolbarDropdown>

      <ToolbarDivider />

      {/* ── 编辑器视图设置辅助组 ── */}
      <ToolbarButton
        icon={<WrapText size={15} />}
        title="自动换行 (Soft Wrap)"
        active={editorSettings.softWrap}
        onClick={() => setEditor({ softWrap: !editorSettings.softWrap })}
      />
      <ToolbarButton
        icon={<ListOrdered size={15} />}
        title="显示行号 (Line Numbers)"
        active={editorSettings.showLineNumbers !== false}
        onClick={() => setEditor({ showLineNumbers: !(editorSettings.showLineNumbers !== false) })}
      />
      <ToolbarButton
        icon={<Eye size={15} />}
        title="显示空白字符与换行符"
        active={editorSettings.showWhitespace}
        onClick={() => setEditor({ showWhitespace: !editorSettings.showWhitespace })}
      />

      <ToolbarDivider />

      {/* ── 快速查找与替换 ── */}
      <ToolbarButton
        icon={<Search size={15} />}
        title="查找文本"
        shortcut="Ctrl+F"
        onClick={() => openSearch(undefined, 'search')}
      />
      <ToolbarButton
        icon={<Replace size={15} />}
        title="替换文本"
        shortcut="Ctrl+H"
        onClick={() => openSearch(undefined, 'replace')}
      />
    </div>
  );
}
