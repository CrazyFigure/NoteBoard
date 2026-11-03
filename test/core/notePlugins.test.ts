// 跨端入口共享同一扩展名与只读契约，未安装插件也不能把原生笔记解码成可写文本。
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { kindFromPath, isEditable } from '../../src/core/docKind';
import { OFFICIAL_PLUGINS, previewPluginFor } from '../../src/features/plugins/pluginTypes';

it('桌面、移动和网页识别同一笔记插件，保持只读且分别管理', () => {
  for (const [extension, id] of [['note', 'notability'], ['goodnotes', 'goodnotes']]) {
    for (const path of [`C:/笔记/课堂.${extension}`, `/storage/课堂.${extension.toUpperCase()}`, `/workspace/a.${extension}`]) {
      expect(kindFromPath(path)).toBe('preview');
      expect(previewPluginFor(path)).toBe(id);
    }
    expect(OFFICIAL_PLUGINS.filter((plugin) => plugin.id === id)).toHaveLength(1);
  }
  expect(isEditable('preview')).toBe(false);
  expect(previewPluginFor('other.ntb')).toBeNull();
});

it('原生文件关联保持 Viewer，插件要求新增格式识别版本', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
  const viewer = config.bundle.fileAssociations.find((entry: { name: string }) => entry.name === 'NoteBoard.DocumentPreview');
  expect(viewer.role).toBe('Viewer');
  expect(viewer.ext).toEqual(expect.arrayContaining(['note', 'goodnotes']));
  const metadata = JSON.parse(readFileSync('plugins/versions.json', 'utf8'));
  for (const id of ['notability', 'goodnotes']) expect(metadata.find((item: { id: string }) => item.id === id).minAppVersion).toBe('0.7.4');
});
