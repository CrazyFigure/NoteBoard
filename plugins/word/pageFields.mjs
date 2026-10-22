/** 在页眉页脚中标记 PAGE / NUMPAGES 的缓存结果，渲染后按实际页数更新。
 * 只处理顺序十进制页码；重启编号、罗马数字和其它域指令保留文件缓存，避免误改业务文字。
 */
export function markPageNumberFields(document) {
  const body = document.documentPart.body;
  const sections = [...body.children.map((node) => node.sectionProps), body.props].filter(Boolean);
  const sequential = sections.every((props, index) => (!props.pageNumber?.format || props.pageNumber.format === 'decimal')
    && (props.pageNumber?.start == null || (index === 0 && props.pageNumber.start === 1)));
  for (const part of document.parts) {
    if (!['header', 'footer'].includes(part.rootElement?.type)) continue;
    const fields = [];
    /** 域可跨多个 run；正文中的静态数字和不支持的域结果均保持原样。 */
    function visit(node) {
      if (node.type === 'complexField') {
        if (node.charType === 'begin') fields.push({ code:'', result:false, marked:false });
        else if (node.charType === 'separate' && fields.length) fields.at(-1).result = true;
        else if (node.charType === 'end') fields.pop();
      } else if (node.type === 'instruction' && fields.length) {
        fields.at(-1).code += node.text;
      } else if (node.type === 'text' && fields.length === 1 && fields[0].result) {
        const field = fields[0];
        const match = /^\s*(PAGE|NUMPAGES)\s*(?:\\\*\s*(?:MERGEFORMAT|Arabic)\s*)?$/i.exec(field.code);
        if (match && (match[1].toUpperCase() === 'NUMPAGES' || sequential)) {
          if (field.marked) return null;
          field.marked = true;
          // 嵌套 span 仅替换域内缓存文本，保留同一 run 中的前后文字及原有样式。
          return { type:'run', className:`np-word-field-${match[1].toLowerCase()}`, children:[node] };
        }
      } else if (node.children) {
        node.children = node.children.map(visit).filter(Boolean);
      }
      return node;
    }
    visit(part.rootElement);
  }
}

/** 分页完成后更新每页副本，防止所有页脚沿用文件保存的第一页缓存。 */
export function updatePageNumberFields(root) {
  const pages = Array.from(root.querySelectorAll('section.docx'));
  pages.forEach((page, index) => {
    for (const field of page.querySelectorAll('.np-word-field-page')) field.textContent = String(index + 1);
    for (const field of page.querySelectorAll('.np-word-field-numpages')) field.textContent = String(pages.length);
  });
}
