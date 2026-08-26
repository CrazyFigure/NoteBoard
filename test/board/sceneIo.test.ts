// NoteBoard 画板场景序列化与 AppState 清洗测试
// 验证 cleanAppState、parseScene、serializeScene 等核心场景数据处理逻辑

import { describe, it, expect } from 'vitest';
import {
  cleanAppState,
  parseScene,
  serializeScene,
  createEmptyScene,
  isVersionSupported,
  getElementCount,
  getBoardHistorySignature,
  type ExcalidrawScene,
} from '../../src/features/board/sceneIo';

describe('sceneIo - 画板场景数据处理', () => {
  describe('cleanAppState', () => {
    it('应剔除协作、选区和全屏演示等运行时临时字段，并保留 objectsSnapModeEnabled', () => {
      const dirtyAppState = {
        viewBackgroundColor: '#1e1e1e',
        gridSize: 20,
        objectsSnapModeEnabled: false,
        snapLines: [{ type: 'points', points: [[0, 0], [10, 10]] }],
        originSnapOffset: { x: 5, y: 5 },
        collaborators: {}, // 模拟 JSON 反序列化产生的普通空对象
        selectedElementIds: { el1: true },
        previousSelectedElementIds: { el0: true },
        selectedGroupIds: { group1: true },
        editingGroupId: 'group1',
        editingElement: null,
        resizingElement: null,
        draggingElement: null,
        cursorButton: 'up',
        openMenu: null,
        openSidebar: null,
        activeEmbeddable: null,
        viewModeEnabled: true,
        zenModeEnabled: true,
        zoom: { value: 1.5 },
      };

      const cleaned = cleanAppState(dirtyAppState);

      // 验证 collaborators 与 snapLines 已被彻底移除
      expect('collaborators' in cleaned).toBe(false);
      expect('snapLines' in cleaned).toBe(false);
      expect('originSnapOffset' in cleaned).toBe(false);
      expect('selectedElementIds' in cleaned).toBe(false);
      expect('editingGroupId' in cleaned).toBe(false);
      expect('viewModeEnabled' in cleaned).toBe(false);
      expect('zenModeEnabled' in cleaned).toBe(false);

      // 验证必要设置与吸附设置依然保留
      expect(cleaned.viewBackgroundColor).toBe('#1e1e1e');
      expect(cleaned.gridSize).toBe(20);
      expect(cleaned.objectsSnapModeEnabled).toBe(false);
      expect(cleaned.zoom).toEqual({ value: 1.5 });
    });

    it('当传入空值或未配置吸附时应返回默认启用吸附的 AppState', () => {
      const cleanedNull = cleanAppState(null);
      expect(cleanedNull).toEqual({ viewBackgroundColor: '#ffffff', gridSize: null, objectsSnapModeEnabled: true });

      const cleanedUndefined = cleanAppState(undefined);
      expect(cleanedUndefined).toEqual({ viewBackgroundColor: '#ffffff', gridSize: null, objectsSnapModeEnabled: true });

      const cleanedWithoutSnap = cleanAppState({ viewBackgroundColor: '#000000', gridSize: 10 });
      expect(cleanedWithoutSnap.objectsSnapModeEnabled).toBe(true);
    });
  });

  describe('parseScene', () => {
    it('解析包含 collaborators 普通对象的 JSON 时应自动完成清理并默认启用吸附', () => {
      const rawJson = JSON.stringify({
        type: 'excalidraw',
        version: 2,
        source: 'noteboard',
        elements: [],
        appState: {
          viewBackgroundColor: '#ffffff',
          gridSize: null,
          collaborators: {}, // 导致 Excalidraw 崩溃的根源
        },
        files: {},
      });

      const parsed = parseScene(rawJson);

      expect(parsed.type).toBe('excalidraw');
      expect(parsed.version).toBe(2);
      expect('collaborators' in parsed.appState).toBe(false);
      expect(parsed.appState.objectsSnapModeEnabled).toBe(true);
    });

    it('解析已显式禁用吸附的 JSON 时应正确保留各个文件的设置', () => {
      const rawJson = JSON.stringify({
        elements: [{ id: '1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
        appState: {
          objectsSnapModeEnabled: false,
        },
      });

      const parsed = parseScene(rawJson);
      expect(parsed.appState.objectsSnapModeEnabled).toBe(false);
    });

    it('解析缺少必要字段的 JSON 时应补全默认结构', () => {
      const rawJson = JSON.stringify({
        elements: [{ id: '1', type: 'rectangle', x: 0, y: 0, width: 100, height: 100 }],
      });

      const parsed = parseScene(rawJson);

      expect(parsed.type).toBe('excalidraw');
      expect(parsed.version).toBe(2);
      expect(parsed.source).toBe('noteboard');
      expect(parsed.appState).toBeDefined();
      expect(parsed.appState.objectsSnapModeEnabled).toBe(true);
      expect(parsed.files).toEqual({});
    });

    it('当 JSON 缺少 elements 数组时应抛出错误', () => {
      const invalidJson = JSON.stringify({
        type: 'excalidraw',
      });

      expect(() => parseScene(invalidJson)).toThrowError('Invalid Excalidraw file: missing elements array');
    });
  });

  describe('serializeScene', () => {
    it('序列化时应自动清洗 appState 中的脏字段并保留吸附设置', () => {
      const scene: ExcalidrawScene = {
        type: 'excalidraw',
        version: 2,
        source: 'noteboard',
        elements: [],
        appState: {
          viewBackgroundColor: '#ffffff',
          gridSize: null,
          objectsSnapModeEnabled: false,
          snapLines: [{ type: 'points', points: [] }],
          collaborators: new Map(), // 运行时 Map
          selectedElementIds: { 'node-1': true },
        } as unknown as ExcalidrawScene['appState'],
        files: {},
      };

      const jsonStr = serializeScene(scene);
      const deserialized = JSON.parse(jsonStr);

      expect('collaborators' in deserialized.appState).toBe(false);
      expect('snapLines' in deserialized.appState).toBe(false);
      expect('selectedElementIds' in deserialized.appState).toBe(false);
      expect(deserialized.appState.viewBackgroundColor).toBe('#ffffff');
      expect(deserialized.appState.objectsSnapModeEnabled).toBe(false);
    });
  });

  describe('createEmptyScene & getElementCount', () => {
    it('按亮色/暗色模式创建空场景并默认启用自动吸附', () => {
      const light = createEmptyScene(false);
      expect(light.appState.viewBackgroundColor).toBe('#ffffff');
      expect(light.appState.objectsSnapModeEnabled).toBe(true);

      const dark = createEmptyScene(true);
      expect(dark.appState.viewBackgroundColor).toBe('#1e1e1e');
      expect(dark.appState.objectsSnapModeEnabled).toBe(true);
    });

    it('正确判断版本支持与统计未删除图元数', () => {
      const scene = createEmptyScene(false);
      expect(isVersionSupported(scene)).toBe(true);

      scene.elements = [
        { id: '1', type: 'rectangle', isDeleted: false } as ExcalidrawScene['elements'][number],
        { id: '2', type: 'ellipse', isDeleted: true } as ExcalidrawScene['elements'][number],
        { id: '3', type: 'arrow', isDeleted: false } as ExcalidrawScene['elements'][number],
      ];
      expect(getElementCount(scene)).toBe(2);
    });
  });

  describe('getBoardHistorySignature', () => {
    it('点击选中、滚动和缩放不计为操作，图元真实变化才计入历史', () => {
      const base = createEmptyScene(false);
      base.elements = [{
        id: 'node-1',
        type: 'rectangle',
        version: 1,
        versionNonce: 10,
        isDeleted: false,
      } as ExcalidrawScene['elements'][number]];

      const interactionOnly: ExcalidrawScene = {
        ...base,
        appState: {
          ...base.appState,
          selectedElementIds: { 'node-1': true },
          scrollX: -300,
          scrollY: -200,
          zoom: { value: 1.5 },
          viewModeEnabled: true,
          zenModeEnabled: true,
        },
      };
      expect(getBoardHistorySignature(interactionOnly)).toBe(getBoardHistorySignature(base));

      const changed: ExcalidrawScene = {
        ...interactionOnly,
        elements: [{ ...interactionOnly.elements[0], version: 2 }],
      };
      expect(getBoardHistorySignature(changed)).not.toBe(getBoardHistorySignature(base));
    });
  });
});
