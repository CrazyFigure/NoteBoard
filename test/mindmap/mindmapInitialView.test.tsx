// 大导图首次显示与保存屏障：折叠副本不能污染正文，用户展开后才提交显示状态。
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { MindNode } from '@/features/mindmap/mindmapTypes';
const harness = vi.hoisted(() => ({ root: null as MindNode | null, onChange: null as ((root: MindNode) => void) | null }));
vi.mock('@/features/mindmap/MindmapRenderer', () => ({ MindmapRenderer: (props: { root: MindNode; onChange: (root: MindNode) => void }) => {
  harness.root = props.root; harness.onChange = props.onChange; return <div />;
} }));
vi.mock('@/components/Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
import { MindmapEditor } from '@/features/mindmap/MindmapEditor';
import { serializeMindmapDocument } from '@/features/mindmap/mindmapConverter';
import { cloneMindmapTree, getMindmapTreeStats } from '@/features/mindmap/mindmapTree';
import { useDocumentStore } from '@/stores/documentStore';
import { useWindowStore } from '@/stores/windowStore';
import { getEditorCapabilities } from '@/core/editor/editorRegistry';

describe('大导图首次显示', () => {
  it('打开/flush 不把自动折叠写入正文，用户展开后按当前状态记录', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const nodes: MindNode[] = Array.from({ length: 501 }, (_, index) => ({ id: `n${index}`, text: `节点${index}`, isExpanded: true, children: [] }));
    for (let index = 1; index < nodes.length; index += 1) nodes[Math.floor((index - 1) / 5)].children.push(nodes[index]);
    const content = serializeMindmapDocument(nodes[0]);
    const key = 'C:/test/initial-view.mindmap';
    useDocumentStore.getState().upsertFromPayload({ key, displayName: 'initial-view.mindmap', dirPath: 'C:/test', kind: 'mindmap', language: 'json', content,
      encoding: 'utf8', eol: 'lf', size: content.length, mtime: 0, readonly: false });
    useWindowStore.getState().openTab({ key, displayName: 'initial-view.mindmap', path: key, kind: 'mindmap', language: 'json', isDirty: false,
      isPreview: false, viewMode: null, externalStatus: null, isDetached: false });
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => root.render(<MindmapEditor docKey={key} />));
      expect(harness.root!.children.every((node) => !node.isExpanded)).toBe(true);
      await act(async () => { await getEditorCapabilities(key)!.flush('save'); });
      const saved = JSON.parse(useDocumentStore.getState().getDocument(key)!.content!).root as MindNode;
      expect(saved.children.every((node) => node.isExpanded)).toBe(true);
      expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(false);
      const expanded = cloneMindmapTree(harness.root!); expanded.children[0].isExpanded = true;
      await act(async () => harness.onChange!(expanded));
      const changed = JSON.parse(useDocumentStore.getState().getDocument(key)!.content!).root as MindNode;
      expect(changed.children[0].isExpanded).toBe(true);
      expect(changed.children[1].isExpanded).toBe(false);
      expect(getMindmapTreeStats(changed).nodeCount).toBe(501);
      expect(useDocumentStore.getState().getDocument(key)?.isDirty).toBe(true);
    } finally {
      await act(async () => root.unmount()); host.remove();
    }
  });
});
