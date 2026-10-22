// 预览预算按实际引用的块和展开复杂度计算；图纸只在内存中整理，绝不改写源文件。
import { computeCadDocumentBounds, createCadSceneDocument } from '@flyfish-dev/cad-viewer';

export const CAD_LIMITS = Object.freeze({
  // 与桌面二进制读取和网页文件服务保持一致，插件更新即可生效，无须修改宿主。
  fileBytes: 50 * 1024 * 1024,
  sourceEntities: 1_000_000,
  expandedEntities: 2_000_000,
  geometryPoints: 4_000_000,
  renderPoints: 12_000_000,
  blocks: 20_000,
  insertDepth: 32,
  textCharacters: 500_000,
  parseTimeoutMs: 120_000,
});

/** 在解析线程去除无用块及业务缓存，记忆化检查块引用，返回完整可绘制场景与有界文字。 */
export function prepareScene(document) {
  const sourceBlocks = document.blocks ?? {};
  // 归一化器通常提供小写别名；缺少别名的 DXF 也按块名大小写无关的规则查找。
  const blockLookup = new Map();
  for (const [key, block] of Object.entries(sourceBlocks)) {
    blockLookup.set(key.toLowerCase(), block);
    if (typeof block.name === 'string') blockLookup.set(block.name.toLowerCase(), block);
  }
  const reachable = new Set();
  const visiting = new Set();
  const cache = new Map();
  const seenEntities = new Set();
  const textParts = [];
  let sourceEntities = 0, geometryPoints = 0, textCharacters = 0, textTruncated = false;

  /** 所有数值预算均在展开之前检查，避免阵列或共享块先占满内存。 */
  const check = (value, limit, label) => {
    if (!Number.isFinite(value) || value > limit) {
      throw new Error(`图纸${label}超过当前预览预算（${limit.toLocaleString('zh-CN')}），请使用专业 CAD 软件。`);
    }
  };

  /** 块名只有 INSERT 才有引用语义，普通文字的 name 不应触发递归。 */
  const findBlock = (entity) => {
    if ((entity.kind ?? String(entity.type).toLowerCase()) !== 'insert' && entity.type !== 'MINSERT') return;
    const name = entity.blockName ?? entity.name;
    return typeof name === 'string' ? sourceBlocks[name] ?? blockLookup.get(name.toLowerCase()) : undefined;
  };

  /** 统计全部几何入口，包含样条、填充边界与路径数据，不能只数 vertices。 */
  const pointCount = (entity) => {
    let points = 0;
    for (const key of ['vertices', 'points', 'controlPoints', 'fitPoints', 'path', 'knots']) points += entity[key]?.length ?? 0;
    for (const command of entity.commands ?? []) points += 1 + (command.points?.length ?? 0);
    for (const loop of entity.loops ?? []) {
      points += loop.vertices?.length ?? 0;
      for (const command of loop.commands ?? []) points += 1 + (command.points?.length ?? 0);
    }
    return points;
  };

  /** 文字逐条截取且显式标记截断，避免先拼接整个大图纸后才裁剪。 */
  const collectText = (entity) => {
    const value = entity.text ?? entity.value;
    if (typeof value !== 'string' || !value) return;
    const remaining = CAD_LIMITS.textCharacters - textCharacters;
    if (remaining <= 1) { textTruncated = true; return; }
    const part = value.slice(0, remaining - 1);
    textParts.push(part);
    textCharacters += part.length + 1;
    if (part.length < value.length) textTruncated = true;
  };

  /** 源实体只计一次；清理渲染器不使用的扩展数据，降低跨线程克隆及 INSERT 复制成本。 */
  const inspectEntity = (entity) => {
    const points = pointCount(entity);
    if (!seenEntities.has(entity)) {
      seenEntities.add(entity);
      check(++sourceEntities, CAD_LIMITS.sourceEntities, '源实体数');
      geometryPoints += points;
      check(geometryPoints, CAD_LIMITS.geometryPoints, '几何数据量');
      delete entity.raw;
      delete entity.xdata;
      collectText(entity);
    }
    // 圆弧细分计入预算；大场景统一使用 48 段上限，不减少源实体或图纸范围。
    const kind = entity.kind ?? String(entity.type).toLowerCase();
    const renderPoints = ['arc', 'circle', 'ellipse'].includes(kind) ? 49 : Math.max(2, points * 2);
    return { expandedEntities: 1, renderPoints, depth: 0 };
  };

  /** 合并时按引用次数乘算，重复块只解析一次，但每个实例的绘制成本都必须计入。 */
  const add = (total, item, copies = 1) => {
    total.expandedEntities += item.expandedEntities * copies;
    total.renderPoints += item.renderPoints * copies;
    total.depth = Math.max(total.depth, item.depth);
    check(total.expandedEntities, CAD_LIMITS.expandedEntities, '展开实体数');
    check(total.renderPoints, CAD_LIMITS.renderPoints, '绘制几何量');
    check(total.depth, CAD_LIMITS.insertDepth, '块嵌套层数');
  };

  /** 先检测环和深度再记忆化，拒绝损坏图纸，避免渲染器静默截断递归内容。 */
  const visitBlock = (block, depth) => {
    if (visiting.has(block)) throw new Error('图纸存在循环块引用，无法完整预览，请使用专业 CAD 软件检查。');
    check(depth, CAD_LIMITS.insertDepth, '块嵌套层数');
    if (cache.has(block)) return cache.get(block);
    reachable.add(block);
    check(reachable.size, CAD_LIMITS.blocks, '引用块数量');
    visiting.add(block);
    const result = visitEntities(block.entities ?? [], depth);
    visiting.delete(block);
    cache.set(block, result);
    return result;
  };

  /** 属性文字同样受预算保护；阵列乘数异常时明确失败，禁止无界枚举。 */
  const visitEntities = (entities, depth = 0, attributeDepth = 0) => {
    check(attributeDepth, CAD_LIMITS.insertDepth, '属性嵌套层数');
    const total = { expandedEntities: 0, renderPoints: 0, depth: 0 };
    for (const entity of entities) {
      add(total, inspectEntity(entity));
      if (entity.attribs?.length) add(total, visitEntities(entity.attribs, depth, attributeDepth + 1));
      const block = findBlock(entity);
      if (!block) continue;
      const count = (value) => value == null || value === 0 ? 1 : Number.isSafeInteger(value) && value > 0 ? value : NaN;
      const copies = count(entity.insertRowCount) * count(entity.insertColumnCount);
      check(copies, CAD_LIMITS.expandedEntities, '阵列实例数');
      const child = visitBlock(block, depth + 1);
      add(total, { ...child, depth: child.depth + 1 }, copies);
    }
    return total;
  };

  const totals = visitEntities(document.entities ?? []);
  // LibreDWG 同时返回模型空间实体和 *MODEL_SPACE 块；只传实际引用的定义及其别名。
  document.blocks = Object.fromEntries(Object.entries(sourceBlocks).filter(([, block]) => reachable.has(block)));
  delete document.raw;
  delete document.xrecords;
  delete document.dictionaries;
  delete document.dataTables;
  delete document.dataLinks;
  const stats = { sourceEntities, geometryPoints, ...totals, blocks: reachable.size };
  const large = totals.expandedEntities > 50_000 || geometryPoints > 200_000;
  const fitMode = resolveInitialFit(document);
  return { document, stats, text: textParts.join('\n'), textTruncated, large, fitMode };
}

/** 原视口没有图形时才尝试目标点偏移；仍为空则显示完整范围，保留有效的原始视角。 */
export function resolveInitialFit(document) {
  const view = document.savedView;
  if (view?.source !== 'vport' || view.sceneTransformApplied !== true) return 'auto';
  const { center, target, viewHeight: height, aspectRatio: ratio } = view;
  if (!Number.isFinite(center?.x) || !Number.isFinite(center?.y) || !Number.isFinite(height) || height <= 0 || !Number.isFinite(ratio) || ratio <= 0) return 'extents';
  const matrix = view.sceneTransform ?? { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const transform = (p) => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f });
  const offset = Number.isFinite(target?.x) && Number.isFinite(target?.y) ? transform(target) : { x: 0, y: 0 };
  const shifted = { x: center.x + offset.x, y: center.y + offset.y };
  const hits = [0, 0];
  // 块插入点可能远离内部几何；复用渲染器的坐标变换和块边界，不能按插入点误判可见。
  const rendered = createCadSceneDocument(document);
  const probe = { ...rendered, entities: [], pages: undefined };
  for (const entity of rendered.entities ?? []) {
    if (entity.isVisible === false) continue;
    probe.entities[0] = entity;
    const bounds = computeCadDocumentBounds(probe, { maxInsertDepth: CAD_LIMITS.insertDepth, maxCurveSegments: 48 });
    for (const [index, candidate] of [center, shifted].entries()) {
      if (bounds.minX <= candidate.x + height * ratio / 2 && bounds.maxX >= candidate.x - height * ratio / 2 && bounds.minY <= candidate.y + height / 2 && bounds.maxY >= candidate.y - height / 2) hits[index]++;
    }
    // 原视口已有几何就保持原样，无须继续遍历大图纸。
    if (hits[0] > 0) return 'auto';
  }
  if (hits[1] > 0) {
    // 只修正内存中的预览视口；CAD 文件、几何坐标和用户保存的视角都不落盘修改。
    document.savedView = { ...view, center: shifted };
    if (document.metadata) document.metadata.savedView = document.savedView;
    return 'auto';
  }
  return 'extents';
}

/** 大图纸依靠 GPU 分批和视口裁剪；兼容模式保留小图纸，避免每次拖动扫描几十万实体。 */
export function canvasOptionsForScene(scene, webglAvailable) {
  if (scene.large && !webglAvailable) throw new Error('此图纸需要 WebGL 图形加速，请启用硬件加速后重新打开，或使用专业 CAD 软件。');
  return {
    maxInsertDepth: CAD_LIMITS.insertDepth,
    fitMode: scene.fitMode,
    maxCurveSegments: scene.large ? 48 : 96,
    spatialIndexCellCount: scene.large ? 128 : 64,
    maxVerticesPerBatch: 32_768,
    maxVisibleTextLabels: scene.large ? 800 : 1_200,
    textMinPixelHeight: scene.large ? 5 : 3,
    antialias: false,
    powerPreference: scene.large ? 'high-performance' : 'low-power',
    enableSpatialIndex: true,
  };
}
