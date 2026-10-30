// schema 与 Markdown 行为同时对比，防止共享规则拆分后只保持节点名称相同。
import { afterEach, describe, expect, it } from 'vitest';
import { Editor, getExtensionField } from '@tiptap/core';
import type { NodeSpec, MarkSpec } from '@tiptap/pm/model';
import { buildExtensions } from '../../src/features/editor-md/extensions';
import { buildCoreExtensions } from '../../src/features/editor-md/extensions/core';
import { getMarkdownManager, parseMarkdown, serializeMarkdown } from '../../src/features/editor-md/serialize';
import { detailsSourceBlock } from '../../src/features/editor-md/detailsExtension';
import { columnsSourceSnippet } from '../../src/features/editor-md/columnsExtension';
import { calloutSourceSnippet } from '../../src/features/editor-md/calloutExtension';

const editors: Editor[] = [];
/** 两端使用真实扩展初始化，但不创建 DOM 或渲染视图。 */
function pair(wikiLinks = true) {
  const result = [buildCoreExtensions({ wikiLinks }), buildExtensions('', { wikiLinks })]
    .map((extensions) => new Editor({ element: null, extensions, content: '' }));
  editors.push(...result);
  return result;
}
afterEach(() => { editors.splice(0).forEach((editor) => editor.destroy()); });

/** 函数需要后续行为测试；这里比较结构约束、属性和 HTML 规则入口，排除函数绑定身份。 */
function specOf(spec: NodeSpec | MarkSpec) {
  return JSON.parse(JSON.stringify(spec, (_key, value) => typeof value === 'function' ? '[function]' : value));
}

describe('Markdown 核心与完整扩展等价', () => {
  it.each([true, false])('双链启用状态 %s 下节点顺序、标记、默认属性与文档约束相同', (wikiLinks) => {
    const [core, full] = pair(wikiLinks);
    expect(Object.keys(core.schema.nodes)).toEqual(Object.keys(full.schema.nodes));
    expect(Object.keys(core.schema.marks)).toEqual(Object.keys(full.schema.marks));
    for (const [name, node] of Object.entries(core.schema.nodes)) {
      expect(specOf(node.spec), name).toEqual(specOf(full.schema.nodes[name].spec));
      expect(node.createAndFill()?.attrs, name).toEqual(full.schema.nodes[name].createAndFill()?.attrs);
    }
    for (const [name, mark] of Object.entries(core.schema.marks)) {
      expect(specOf(mark.spec), name).toEqual(specOf(full.schema.marks[name].spec));
    }
    // 比较继承后实际生效的 Markdown 回调，不能只检查最外层 config 是否声明字段。
    for (const extension of core.extensionManager.extensions) {
      const rendered = full.extensionManager.extensions.find((item) => item.name === extension.name)!;
      for (const field of ['markdownTokenName', 'markdownTokenizer', 'parseMarkdown', 'renderMarkdown'] as const) {
        expect(typeof getExtensionField(extension, field), `${extension.name}.${field}`)
          .toBe(typeof getExtensionField(rendered, field));
      }
    }
  });

  const samples = [
    '---\ntitle: 测试\n---\n\n# 中文 **粗体 `代码`**\n\n++下划线++ ==高亮== ~~删除~~\n',
    '- 第一项\n  - 两空格子项\n\n    续段\n\n7. 编号\n8. 下一项\n\n- [x] 任务\n  - [ ] 子任务\n',
    '| 项目 | 说明 |\n| --- | --- |\n| 一 | **重点**与 $x$ |\n\n> [!TIP]\n> **提示**\n>\n> 第二段\n',
    '[[笔记|别名]] **![[图片.png]]** 与 $\\frac{a}{b}$\n\n$$\n\\sum_i x_i\n$$\n',
    '````ts\nconst s = "```"\n````\n\n```mermaid\ngraph TD; A-->B\n```\n\n```plantuml\n@startuml\nA->B\n@enduml\n```\n\n```infographic\n标题\n```\n',
    '[![徽章](img/a.png "标题")](https://example.com)\n\n<img src="img/b.png" width="50%" align="left">\n\n文字<kbd>Ctrl</kbd>与&nbsp;[^注]\n\n[^注]: 脚注正文\n',
    '<div class="custom">\n\n**保留 HTML**\n\n</div>\n\n<div align="center">\n\n居中段落\n\n</div>\n',
    detailsSourceBlock('**折叠内容**\n\n- 子项'), columnsSourceSnippet(2), calloutSourceSnippet(),
  ];
  it.each(samples)('解析、源属性和序列化逐字一致：%s', (content) => {
    const [core, full] = pair();
    expect(parseMarkdown(core, content)).toBe(true);
    expect(parseMarkdown(full, content)).toBe(true);
    expect(core.getJSON()).toEqual(full.getJSON());
    expect(core.getHTML()).toBe(full.getHTML());
    expect(serializeMarkdown(core)).toBe(serializeMarkdown(full));
    const normalized = serializeMarkdown(core);
    expect(getMarkdownManager(core)?.parse?.(normalized)).toEqual(getMarkdownManager(full)?.parse?.(normalized));
  });
});
