// NoteBoard 代码与纯文本编辑器顶部操作栏
// 适用于 JSON, TXT, XML, YAML, SQL, LOG, INI 等全部代码与纯文本格式
// 提供撤销/重做、JSON 专属格式化/压缩/校验多级菜单、文本大小写转换、视图辅助设置与搜索替换

import React, { useEffect, useState } from 'react';
import {
  Undo2,
  Redo2,
  Braces,
  CodeXml,
  CaseSensitive,
  WrapText,
  ListOrdered,
  Eye,
  Columns3,
  Search,
  Replace,
  Sparkles,
  CheckCircle2,
  Minimize2,
  Maximize2,
  Ellipsis,
} from 'lucide-react';
import {
  ToolbarButton,
  ToolbarDivider,
  ToolbarDropdown,
  ToolbarDropdownItem,
  ToolbarDropdownSeparator,
} from './ToolbarComponents';
import {
  undoDocumentHistory,
  redoDocumentHistory,
  useDocumentHistory,
} from '../history/documentHistory';
// 🔴 S03：工具栏通过 core 能力注册表分发，不再从编辑器组件导入实例 getter
import { getEditorCapabilities } from '../../core/editor/editorRegistry';
import { off, on } from '../../core/emitter';
import { formatShortcut } from '../../core/shortcuts';
import { USES_COMMAND_KEY } from '../../core/platform';
import { useSettingsStore } from '../../stores/settingsStore';
import { useSearchStore } from '../../stores/searchStore';
import type { LanguageId } from '../../core/ipc/types';

// Mac 键盘没有 Insert 键，只提示拖动和工具栏入口
const COLUMN_EDIT_SHORTCUT = USES_COMMAND_KEY ? undefined : 'Alt+Shift+Insert';
const COLUMN_EDIT_TITLE = `列编辑（${formatShortcut('Alt')} + 拖动或中键拖动）`;

interface CodeToolbarProps {
  docKey: string;
  language?: string;
  /** 极窄模式：按钮只显示图标，次常用视图开关收进「更多」菜单 */
  compact?: boolean;
  /** 极窄模式「更多」菜单末尾追加的条目（如历史记录） */
  moreItems?: React.ReactNode;
}

export function CodeToolbar({ docKey, language, compact = false, moreItems }: CodeToolbarProps) {
  const lang = (language ?? 'plaintext') as LanguageId;
  const isJson = lang === 'json';
  const { canUndo, canRedo } = useDocumentHistory(docKey);

  // 下拉菜单开闭状态
  const [jsonDropdownOpen, setJsonDropdownOpen] = useState(false);
  const [textDropdownOpen, setTextDropdownOpen] = useState(false);
  const [moreDropdownOpen, setMoreDropdownOpen] = useState(false);
  /** 「更多」菜单内的操作执行后收起菜单 */
  const runFromMore = (action: () => void) => () => {
    setMoreDropdownOpen(false);
    action();
  };

  // 编辑器设置
  const { settings, setEditor } = useSettingsStore();
  const editorSettings = settings.editor;
  const { openSearch } = useSearchStore();

  // ── 代码操作能力（按 docKey 从注册表查询，避免多标签串线） ──
  const getCodeOps = () => getEditorCapabilities(docKey)?.codeOps;

  // ── 列编辑：触屏设备没有 Alt 与中键，工具栏是唯一入口 ──
  const columnEditEnabled = editorSettings.enableColumnEdit !== false;
  const [columnEditActive, setColumnEditActive] = useState(false);
  useEffect(() => {
    const sync = () => {
      setColumnEditActive(getEditorCapabilities(docKey)?.codeOps?.isColumnEditActive?.() ?? false);
    };
    sync();
    on('column-edit-changed', sync);
    return () => off('column-edit-changed', sync);
  }, [docKey]);

  // ── JSON 操作分发 ──
  const onExpandJson = (scope: 'all' | 'selection', tabSize?: number) => {
    setJsonDropdownOpen(false);
    getCodeOps()?.expandJson({ scope, tabSize });
  };

  const onMinifyJson = (scope: 'all' | 'selection') => {
    setJsonDropdownOpen(false);
    getCodeOps()?.minifyJson(scope);
  };

  const onValidateJson = (scope: 'all' | 'selection') => {
    setJsonDropdownOpen(false);
    getCodeOps()?.validateJson(scope);
  };

  // ── 文本转换分发 ──
  const onTransformCase = (mode: 'upper' | 'lower' | 'title') => {
    setTextDropdownOpen(false);
    getCodeOps()?.transformCase(mode);
  };

  // ── XML 格式化 ──
  const onFormatXml = (scope: 'all' | 'selection') => {
    setTextDropdownOpen(false);
    getCodeOps()?.formatXml(scope);
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

      {/* ── JSON 工具组（二级菜单）；极窄模式仅在 JSON 文件中显示，快捷键始终可用 ── */}
      {(!compact || isJson) && <ToolbarDropdown
        isOpen={jsonDropdownOpen}
        onOpenChange={setJsonDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<Braces size={15} />}
            label={compact ? undefined : 'JSON 工具'}
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
      </ToolbarDropdown>}

      {/* ── 文本与代码增强工具组（二级菜单） ── */}
      <ToolbarDropdown
        isOpen={textDropdownOpen}
        onOpenChange={setTextDropdownOpen}
        trigger={
          <ToolbarButton
            icon={<Sparkles size={15} />}
            label={compact ? undefined : '文本工具'}
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
      {!compact && (<>
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
      {columnEditEnabled && (
        <ToolbarButton
          icon={<Columns3 size={15} />}
          title={COLUMN_EDIT_TITLE}
          shortcut={COLUMN_EDIT_SHORTCUT}
          active={columnEditActive}
          onClick={() => getCodeOps()?.toggleColumnEdit?.()}
        />
      )}
      </>)}

      <ToolbarDivider />

      {/* ── 快速查找与替换 ── */}
      <ToolbarButton
        icon={<Search size={15} />}
        title="查找文本"
        shortcut="Ctrl+F"
        onClick={() => openSearch(undefined, 'search')}
      />
      {!compact && (
        <ToolbarButton
          icon={<Replace size={15} />}
          title="替换文本"
          shortcut="Ctrl+H"
          onClick={() => openSearch(undefined, 'replace')}
        />
      )}

      {/* ── 极窄模式「更多」菜单：行号、空白字符、替换与外部追加条目 ── */}
      {compact && (
        <ToolbarDropdown
          isOpen={moreDropdownOpen}
          onOpenChange={setMoreDropdownOpen}
          align="right"
          trigger={
            <ToolbarButton
              icon={<Ellipsis size={15} strokeWidth={2.2} />}
              title="更多"
              active={moreDropdownOpen}
            />
          }
        >
          <ToolbarDropdownItem
            icon={<ListOrdered size={14} />}
            label="显示行号"
            active={editorSettings.showLineNumbers !== false}
            onClick={runFromMore(() => setEditor({ showLineNumbers: !(editorSettings.showLineNumbers !== false) }))}
          />
          <ToolbarDropdownItem
            icon={<Eye size={14} />}
            label="显示空白字符"
            active={editorSettings.showWhitespace}
            onClick={runFromMore(() => setEditor({ showWhitespace: !editorSettings.showWhitespace }))}
          />
          {columnEditEnabled && (
            <ToolbarDropdownItem
              icon={<Columns3 size={14} />}
              label="列编辑"
              shortcut={COLUMN_EDIT_SHORTCUT}
              active={columnEditActive}
              onClick={runFromMore(() => getCodeOps()?.toggleColumnEdit?.())}
            />
          )}
          <ToolbarDropdownSeparator />
          <ToolbarDropdownItem
            icon={<Replace size={14} />}
            label="替换文本"
            shortcut="Ctrl+H"
            onClick={runFromMore(() => openSearch(undefined, 'replace'))}
          />
          {moreItems && (
            <>
              <ToolbarDropdownSeparator />
              {/* 外部条目点击后同样收起菜单 */}
              <div onClickCapture={() => setMoreDropdownOpen(false)} style={{ display: 'contents' }}>
                {moreItems}
              </div>
            </>
          )}
        </ToolbarDropdown>
      )}
    </div>
  );
}
