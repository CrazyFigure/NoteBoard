// NoteBoard 思维导图节点图片尺寸缓存
// 「原始比例」显示需要图片的固有宽高才能排版；首次遇到的图片异步加载测量，
// 测得后通知订阅者重新排版。未测得前按「宽度填充」的固定高度占位。
// 详见 docs/09-开发路线图.md

export interface ImageSize {
  width: number;
  height: number;
}

const sizes = new Map<string, ImageSize | null>();
const loading = new Set<string>();
const listeners = new Set<() => void>();

function notify() {
  for (const fn of listeners) fn();
}

/** 加载图片并记录固有尺寸；失败记为 null（不再重试） */
export function loadImageSize(src: string): Promise<ImageSize | null> {
  const cached = sizes.get(src);
  if (cached !== undefined) return Promise.resolve(cached);
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') {
      resolve(null);
      return;
    }
    loading.add(src);
    const img = new Image();
    const finish = (size: ImageSize | null) => {
      loading.delete(src);
      sizes.set(src, size);
      notify();
      resolve(size);
    };
    img.onload = () =>
      finish(img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null);
    img.onerror = () => finish(null);
    img.src = src;
  });
}

/** 同步读取已测得的尺寸；未测得时触发后台加载并返回 undefined */
export function getImageSize(src: string): ImageSize | undefined {
  const cached = sizes.get(src);
  if (cached !== undefined) return cached ?? undefined;
  if (!loading.has(src)) void loadImageSize(src);
  return undefined;
}

/** 订阅尺寸测得事件（用于触发重新排版） */
export function subscribeImageSizes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 测试用：直接写入尺寸 */
export function primeImageSize(src: string, size: ImageSize | null): void {
  sizes.set(src, size);
}
