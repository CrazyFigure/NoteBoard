/** 历史分页标记与手动分页符可指向同一个页边界；只移除页首的重复历史标记。
 * 不删除渲染后的空页，也不合并连续的手动分页符，避免吞掉用户有意保留的空白页。
 */
export function deduplicatePageBreaks(document) {
  let atPageStart = true;
  /** 顺序遍历正文行内节点，超链接等容器不能打断分页边界状态。 */
  function visit(node) {
    if (node.type === 'break') {
      if (node.break === 'lastRenderedPageBreak' && atPageStart) return false;
      if (node.break === 'page' || node.break === 'lastRenderedPageBreak') atPageStart = true;
      else atPageStart = false;
    } else if (node.type === 'text') {
      if (node.text?.length) atPageStart = false;
    } else if (node.children) {
      node.children = node.children.filter(visit);
    } else if (!['bookmarkStart', 'bookmarkEnd'].includes(node.type)) {
      // 图片、制表符与其它可见节点占用版面，后续历史标记可能是独立分页，必须保留。
      atPageStart = false;
    }
    return true;
  }
  for (const block of document.documentPart.body.children) {
    if (block.type !== 'paragraph') { atPageStart = false; continue; }
    const hadContent = block.children?.some((node) => node.children?.length);
    visit(block);
    // 一个原本为空的段落也占据行高，不能越过它合并后续分页。
    if (!hadContent) atPageStart = false;
  }
}
