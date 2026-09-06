// NoteBoard Markdown 可视化内核（S08：visual 运行时独立组件）
// 🔴 拆分目的（docs/启动性能与低内存根治计划.md §P2/S08）：
//   1. source 初始模式（大文档/用户首选）不创建 TipTap 实例——内核只在
//      文档首次进入 visual 模式时挂载，挂载后常驻（display 切换，保留撤销栈与选区）。
//   2. 初始化锁（isInitializingRef）由协调器持有并以引用共享：程序化内容设置
//      在同步作用域内加锁/解锁，不再用 50ms 时间窗忽略真实输入。
//   3. 超链接弹窗、右键菜单、气泡菜单等 visual 专属 UI 全部内聚在本组件。

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import { undoDepth as prosemirrorUndoDepth } from '@tiptap/pm/history';
import { on, off } from '../../core/emitter';
import { registerShortcut } from '../../core/shortcuts';
import { buildExtensions } from './extensions';
import { getMarkdownManager } from './serialize';
// 🔴 J2：输入热路径只暂存不可变快照（O(1)）；序列化按历史组延迟执行
import {
  stagePendingVisualSnapshot,
  flushPendingVisualSnapshot,
  hasPendingVisualSnapshot,
} from './visualSnapshot';
import { handlePastedImageFile } from './imagePaste';
import { EditorBubbleMenu, TableToolbar } from './bubbleMenu';
import { BlockDragHandle } from './blockDragHandle';
import { EditorContextMenu } from './EditorContextMenu';
import { LinkModal } from './LinkModal';
import { useDocumentStore } from '../../stores/documentStore';
import { useWindowStore } from '../../stores/windowStore';
import { bumpDocumentRevision, getDocumentRevision } from '../../core/editor/editorRegistry';
import { autoSaveDocument } from './markdownAutoSave';
import { registerHistoryMaterializeHook } from '../history/documentHistory';

interface VisualKernelProps {
  docKey: string;
  /** visual 容器是否可见（父组件以 display 切换；卸载由父控制挂载生命周期） */
  visible: boolean;
  /** editor 实例就绪/销毁回调（null 表示销毁） */
  onReady: (editor: Editor | null) => void;
  /** 初始化锁（协调器持有；程序化设置内容期间的同步作用域锁定） */
  isInitializingRef: React.MutableRefObject<boolean>;
  /** 原生历史深度镜像（分组识别用，协调器初始化时重置） */
  visualUndoDepthRef: React.MutableRefObject<number>;
  /** store 镜像防抖定时器（与 source 模式共享，切换时由协调器清理） */
  storeTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
  /** 自动保存防抖定时器（与 source 模式共享） */
  diskTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}

export function VisualKernel({
  docKey,
  visible,
  onReady,
  isInitializingRef,
  visualUndoDepthRef,
  storeTimerRef,
  diskTimerRef,
}: VisualKernelProps) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);
  // 超链接插入与编辑弹窗状态
  const [linkModalState, setLinkModalState] = useState<{
    isOpen: boolean;
    initialText: string;
    initialUrl: string;
    isEditing: boolean;
    from: number;
    to: number;
  } | null>(null);
  // LinkClickHandler 扩展在单击超链接时通过该引用唤起弹窗（需绕过扩展闭包）
  const openLinkModalRef = useRef<() => void>(() => {});

  // 初始化 TipTap 编辑器
  const editor = useEditor({
    extensions: buildExtensions(docKey, {
      onOpenLinkModal: () => {
        openLinkModalRef.current();
      },
    }),
    content: '',
    onUpdate: ({ editor, transaction }) => {
      // 🔴 程序事务识别：仅忽略初始化/程序化设置内容的事务（同步作用域锁）；
      //    显示即输入：界面宣布可输入后的第一笔真实按键必须立即进入保护队列
      if (isInitializingRef.current || !transaction.docChanged) {
        return;
      }

      // 🔴 内容版本递增：真实修改（含撤销/重做引起的变化）推进 revision
      bumpDocumentRevision(docKey);

      // 🔴 J2：输入热路径零全文工作——只捕获不可变 ProseMirror 文档根引用（O(1)）
      const nativeUndoDepth = prosemirrorUndoDepth(editor.state);
      const startsNewGroup = nativeUndoDepth > visualUndoDepthRef.current;

      // 新历史组开始：立即物化上一组末端（组内合并结束，跨组节点全部保留——
      // 不因延迟序列化把多组丢成一组）
      if (startsNewGroup && hasPendingVisualSnapshot(docKey)) {
        flushPendingVisualSnapshot(docKey);
      }

      const previousPendingExisted = hasPendingVisualSnapshot(docKey);
      const diffPosition = transaction.before.content.findDiffStart(transaction.doc.content);
      stagePendingVisualSnapshot(docKey, {
        doc: transaction.doc,
        revision: getDocumentRevision(docKey),
        manager: getMarkdownManager(editor),
        schema: editor.schema,
        // 组边界由原生 undoDepth 判定（与防抖物化无关——防抖后同组继续输入仍属同组）
        isNewGroup: startsNewGroup,
        // 组起点选区：本组首事务的 before 位置（TipTap 事务不公开初始选区，
        // 文档首差异位置就是本次修改在旧文档中的稳定落点）
        groupStartBefore: startsNewGroup || !previousPendingExisted
          ? (diffPosition == null ? undefined : { anchor: diffPosition, head: diffPosition })
          : undefined,
        selection: {
          anchor: editor.state.selection.anchor,
          head: editor.state.selection.head,
        },
      });
      visualUndoDepthRef.current = nativeUndoDepth;

      // 🔴 J2 dirty 快速路径：有未物化变化即受保护（保守标脏）；
      //    物化时（防抖/组边界/导航钩子）与基线精确比较重算——改回原文最终清脏
      useWindowStore.getState().setTabDirty(docKey, true);
      useDocumentStore.getState().setDirty(docKey, true);

      // 500ms → 物化暂存（序列化+历史组末端+store 镜像；连续输入不无限顺延——
      // 每次重置定时器，但组边界物化保证跨组及时提交）
      if (storeTimerRef.current) clearTimeout(storeTimerRef.current);
      storeTimerRef.current = setTimeout(() => {
        flushPendingVisualSnapshot(docKey);
      }, 500);

      // 800ms → 盘（auto 策略；先物化保证镜像为最新组末内容）
      if (diskTimerRef.current) clearTimeout(diskTimerRef.current);
      diskTimerRef.current = setTimeout(async () => {
        flushPendingVisualSnapshot(docKey);
        const latest = useDocumentStore.getState().getDocument(docKey)?.content ?? '';
        await autoSaveDocument(docKey, latest);
      }, 800);
    },
    editorProps: {
      attributes: {
        class: 'nb-prose',
        style: 'outline: none; max-width: var(--content-max-width); margin: 0 auto; padding: 16px 24px; min-height: 100%; font-size: var(--content-font-size); line-height: var(--content-line-height); font-family: var(--content-font-family); color: var(--editor-text);',
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of Array.from(items)) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file && editor) {
              event.preventDefault();
              handlePastedImageFile(editor, file, docKey);
              return true;
            }
          }
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = event.dataTransfer?.files;
        if (!files || files.length === 0) return false;
        for (const file of Array.from(files)) {
          if (file.type.startsWith('image/')) {
            if (editor) {
              event.preventDefault();
              handlePastedImageFile(editor, file, docKey);
              return true;
            }
          }
        }
        return false;
      },
    },
  }, [docKey]);

  // 🔴 J2 的合并序列化已按复审要求重做：输入热路径只暂存不可变快照（O(1)），
  //    序列化按历史组延迟执行；编辑器内核常驻期间卸载前的最终内容
  //    由统一 flush 屏障（capabilities.flush）物化捕获。

  // 🔴 J2：注册历史导航/读取前的物化钩子（visual 快照的唯一 owner）——
  //    undo/redo/getCurrent/模式同步/迁移导出都先物化组末端，无需各入口冲刷
  useEffect(() => {
    return registerHistoryMaterializeHook(flushPendingVisualSnapshot);
  }, []);

  // editor 就绪/销毁通知协调器
  useEffect(() => {
    onReady(editor ?? null);
    return () => {
      onReady(null);
    };
  }, [editor, onReady]);

  // 打开超链接插入与编辑模态弹窗
  const handleOpenLinkModal = useCallback(() => {
    if (!editor) return;

    let from = editor.state.selection.from;
    let to = editor.state.selection.to;
    let initialText = '';
    let initialUrl = '';
    let isEditing = false;

    // 1. 若光标处于已有超链接标记内，扩展选区到完整链接范围并回显信息
    if (editor.isActive('link')) {
      isEditing = true;
      editor.commands.extendMarkRange('link');
      from = editor.state.selection.from;
      to = editor.state.selection.to;
      initialText = editor.state.doc.textBetween(from, to);
      initialUrl = editor.getAttributes('link').href || '';
    } else if (!editor.state.selection.empty) {
      // 2. 当前选中了普通文本
      initialText = editor.state.doc.textBetween(from, to);
      initialUrl = '';
    } else {
      // 3. 空选区插入新超链接
      initialText = '';
      initialUrl = '';
    }

    setLinkModalState({
      isOpen: true,
      initialText,
      initialUrl,
      isEditing,
      from,
      to,
    });
  }, [editor]);
  openLinkModalRef.current = handleOpenLinkModal;

  // 监听来自顶部操作栏或外部的唤起超链接弹窗请求
  useEffect(() => {
    const handleOpenModal = (payload: { key?: string }) => {
      if (!payload.key || payload.key === docKey) {
        handleOpenLinkModal();
      }
    };
    on('open-link-modal', handleOpenModal);
    return () => {
      off('open-link-modal', handleOpenModal);
    };
  }, [docKey, handleOpenLinkModal]);

  // 注册当前文档专用的 Ctrl+K 插入/编辑超链接快捷键（visual 内核存在时才注册）
  useEffect(() => {
    const unreg = registerShortcut({
      key: 'Ctrl+K',
      action: () => {
        const activeKey = useWindowStore.getState().activeKey;
        if (activeKey === docKey) {
          handleOpenLinkModal();
        }
      },
      scope: 'global',
      description: '插入或编辑超链接',
    });
    return () => {
      unreg();
    };
  }, [docKey, handleOpenLinkModal]);

  // 确认提交超链接
  const handleConfirmLink = useCallback(
    ({ text, url }: { text: string; url: string }) => {
      if (!editor || !linkModalState) return;

      const { from, to } = linkModalState;
      const targetUrl = url.trim();
      if (!targetUrl) {
        editor.chain().focus().setTextSelection({ from, to }).unsetLink().run();
        setLinkModalState(null);
        return;
      }

      const finalText = text.trim() || targetUrl;
      const originalText = editor.state.doc.textBetween(from, to);

      // 若文本未变且原本非空，仅更新 link 标记属性
      if (originalText === finalText && originalText.length > 0) {
        editor
          .chain()
          .focus()
          .setTextSelection({ from, to })
          .setLink({ href: targetUrl })
          .run();
      } else {
        // 替换文本并挂载超链接标记
        editor
          .chain()
          .focus()
          .setTextSelection({ from, to })
          .insertContent({
            type: 'text',
            text: finalText,
            marks: [
              {
                type: 'link',
                attrs: { href: targetUrl },
              },
            ],
          })
          .run();
      }
      setLinkModalState(null);
    },
    [editor, linkModalState]
  );

  // 移除超链接
  const handleRemoveLink = useCallback(() => {
    if (!editor || !linkModalState) return;
    const { from, to } = linkModalState;
    editor.chain().focus().setTextSelection({ from, to }).unsetLink().run();
    setLinkModalState(null);
  }, [editor, linkModalState]);

  return (
    <div
      style={{
        height: '100%',
        overflow: 'auto',
        position: 'relative',
        display: visible ? 'block' : 'none',
      }}
      onContextMenu={(e) => {
        if (!editor) return;
        e.preventDefault();
        e.stopPropagation();

        const { empty } = editor.state.selection;
        if (empty) {
          const pos = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
          if (pos) {
            editor.commands.setTextSelection(pos.pos);
          }
        }
        setContextMenu({
          x: e.clientX,
          y: e.clientY,
          hasSelection: !empty,
        });
      }}
    >
      {editor && <EditorBubbleMenu editor={editor} onOpenLinkModal={handleOpenLinkModal} />}
      {editor && <TableToolbar editor={editor} />}
      {editor && <BlockDragHandle editor={editor} />}
      {contextMenu && editor && (
        <EditorContextMenu
          editor={editor}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          hasSelection={contextMenu.hasSelection}
          onClose={() => setContextMenu(null)}
          onOpenLinkModal={handleOpenLinkModal}
        />
      )}
      {linkModalState && (
        <LinkModal
          isOpen={linkModalState.isOpen}
          initialText={linkModalState.initialText}
          initialUrl={linkModalState.initialUrl}
          isEditing={linkModalState.isEditing}
          onClose={() => setLinkModalState(null)}
          onConfirm={handleConfirmLink}
          onRemove={handleRemoveLink}
        />
      )}
      <EditorContent editor={editor} style={{ height: '100%' }} />
    </div>
  );
}
