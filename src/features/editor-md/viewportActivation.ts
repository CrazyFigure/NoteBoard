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
    observer?.unobserve(el);
  };
}

/**
 * 取消观察
 */
export function unobserve(el: Element): void {
  pool.delete(el);
  getSharedObserver()?.unobserve(el);
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
