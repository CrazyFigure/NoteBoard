// NoteBoard 视口激活管理
// IntersectionObserver 复用池 + 文档级 fallback + rootMargin: 800px + 一次性触发
// 详见 docs/09-开发路线图.md 8.1

/** 视口激活回调 */
type ActivationCallback = (entry: IntersectionObserverEntry) => void;

/** 观察条目 */
interface ObserverEntry {
  callback: ActivationCallback;
  once: boolean;
  fired: boolean;
}

/** 复用池：WeakMap<Element, ObserverEntry> */
const pool = new WeakMap<Element, ObserverEntry>();

/** 尚未取消观察的元素（WeakMap 不可遍历，导出 PDF 时需据此强制激活全部离屏块） */
const observed = new Set<Element>();

/** 共享 IntersectionObserver */
let sharedObserver: IntersectionObserver | null = null;

/** 初始化共享 observer */
function getSharedObserver(): IntersectionObserver | null {
  if (sharedObserver) return sharedObserver;

  if (typeof IntersectionObserver === 'undefined') {
    return null;
  }

  sharedObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const item = pool.get(entry.target);
        if (!item) continue;

        if (entry.isIntersecting) {
          if (item.once && item.fired) continue;
          item.callback(entry);
          item.fired = true;

          if (item.once) {
            pool.delete(entry.target);
            observed.delete(entry.target);
            sharedObserver?.unobserve(entry.target);
          }
        }
      }
    },
    {
      rootMargin: '800px',
      threshold: 0,
    },
  );

  return sharedObserver;
}

/**
 * 注册元素到视口激活池
 * 当元素进入视口（±800px）时触发回调
 */
export function observe(
  el: Element,
  callback: ActivationCallback,
  options: { once?: boolean } = {},
): () => void {
  const observer = getSharedObserver();
  const entry: ObserverEntry = {
    callback,
    once: options.once ?? false,
    fired: false,
  };

  pool.set(el, entry);

  if (observer) {
    observed.add(el);
    observer.observe(el);
  } else {
    // Fallback: 无 IntersectionObserver 时立即触发
    callback({
      target: el,
      isIntersecting: true,
      intersectionRatio: 1,
    } as IntersectionObserverEntry);
    entry.fired = true;
  }

  // 返回取消观察函数
  return () => {
    pool.delete(el);
    observed.delete(el);
    observer?.unobserve(el);
  };
}

/**
 * 取消观察
 */
export function unobserve(el: Element): void {
  pool.delete(el);
  observed.delete(el);
  getSharedObserver()?.unobserve(el);
}

/**
 * 立即激活容器内所有尚未进入视口的元素
 * 供导出 PDF 等需要完整渲染结果的场景使用：离屏的公式、图表平时按需渲染，导出前必须全部就绪
 */
export function activateWithin(container: Element): void {
  for (const el of [...observed]) {
    // 顺带清理已脱离文档却未取消观察的元素，避免集合长期持有
    if (!el.isConnected) {
      observed.delete(el);
      continue;
    }
    if (!container.contains(el)) continue;
    const item = pool.get(el);
    if (!item || (item.once && item.fired)) continue;
    item.callback({
      target: el,
      isIntersecting: true,
      intersectionRatio: 1,
    } as IntersectionObserverEntry);
    item.fired = true;
    if (item.once) {
      unobserve(el);
    }
  }
}

/**
 * 检查元素是否在视口内
 * 同步检查（基于 getBoundingClientRect）
 */
export function isInViewport(el: Element, margin = 800): boolean {
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  const vw = window.innerWidth || document.documentElement.clientWidth;

  return (
    rect.bottom >= -margin &&
    rect.right >= -margin &&
    rect.top <= vh + margin &&
    rect.left <= vw + margin
  );
}
