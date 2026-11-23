// Markdown 嵌入思维导图的默认初始文档生成器（纯轻量函数，不引入导图渲染或转换运行时）

let nextSeed = 1;

function nextNodeId(prefix: string): string {
  return `node-${Date.now()}-${prefix}-${nextSeed++}`;
}

/**
 * 生成默认思维导图围栏代码块内容（与 .mindmap 文件格式完全一致）
 */
export function createDefaultMindmapCode(title = '中心主题'): string {
  return JSON.stringify(
    {
      version: 1,
      root: {
        id: 'root',
        text: title,
        isExpanded: true,
        children: [
          {
            id: nextNodeId('b1'),
            text: '主要分支 1',
            isExpanded: true,
            children: [
              { id: nextNodeId('c1'), text: '子分支 1.1', children: [] },
              { id: nextNodeId('c2'), text: '子分支 1.2', children: [] },
            ],
          },
          {
            id: nextNodeId('b2'),
            text: '主要分支 2',
            isExpanded: true,
            children: [
              { id: nextNodeId('c3'), text: '子分支 2.1', children: [] },
            ],
          },
          {
            id: nextNodeId('b3'),
            text: '主要分支 3',
            isExpanded: true,
            children: [],
          },
        ],
      },
      layout: 'right',
      theme: 'classic',
    },
    null,
    2,
  );
}
