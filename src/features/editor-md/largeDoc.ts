// NoteBoard 大文档判定
// 阈值判定（单趟扫描，提前 return）+ 降级到 source 模式 + 横幅
// 详见 docs/09-开发路线图.md 7.15
//
// 阈值（来自 note-gen 经验值，非推导值）：
// - VISUAL_MODE_LIMIT: 超过此值不进入 visual 模式
// - SECTION_MODE_LIMIT: 超过此值进入分段模式（阶段11）
// - LARGE_FILE_CONFIRM: 超过此值弹确认框（FR-113）

/** 各阈值 */
export const THRESHOLDS = {
  /** 超过此字符数 → 不进 visual 模式，用 source */
  VISUAL_MODE_LIMIT: 200_000,
  /** 超过此字符数 → 分段模式（阶段11实现） */
  SECTION_MODE_LIMIT: 500_000,
  /** 超过此字节数 → 读盘前弹确认框（FR-113） */
  LARGE_FILE_CONFIRM: 50 * 1024 * 1024, // 50MB
  /** 超过此字符数 → highlightAuto 跳过（代码块内） */
  HIGHLIGHT_AUTO_LIMIT: 5_000,
  /** 超过此字符数 → 单个代码块不高亮 */
  SINGLE_BLOCK_LIMIT: 20_000,
} as const;

/** 大文档判定结果 */
export interface LargeDocVerdict {
  /** 是否为大文档 */
  isLarge: boolean;
  /** 字符数 */
  charCount: number;
  /** 字节数 */
  byteSize: number;
  /** 使用的阈值 */
  threshold: number;
  /** 建议的模式 */
  suggestedMode: 'visual' | 'source' | 'section';
}

/**
 * 判定文档是否为大文档
 * 单趟扫描，提前 return，不递归遍历
 */
export function judgeLargeDoc(content: string, byteSize?: number): LargeDocVerdict {
  const charCount = content.length;
  const bytes = byteSize ?? new Blob([content]).size;

  // 1. 检查是否超过分段模式阈值
  if (charCount > THRESHOLDS.SECTION_MODE_LIMIT) {
    return {
      isLarge: true,
      charCount,
      byteSize: bytes,
      threshold: THRESHOLDS.SECTION_MODE_LIMIT,
      suggestedMode: 'section',
    };
  }

  // 2. 检查是否超过 visual 模式阈值
  if (charCount > THRESHOLDS.VISUAL_MODE_LIMIT) {
    return {
      isLarge: true,
      charCount,
      byteSize: bytes,
      threshold: THRESHOLDS.VISUAL_MODE_LIMIT,
      suggestedMode: 'source',
    };
  }

  // 3. 正常文档
  return {
    isLarge: false,
    charCount,
    byteSize: bytes,
    threshold: THRESHOLDS.VISUAL_MODE_LIMIT,
    suggestedMode: 'visual',
  };
}

/**
 * 判定单个代码块是否应该跳过高亮
 */
export function shouldSkipCodeBlockHighlight(codeText: string): boolean {
  return codeText.length > THRESHOLDS.SINGLE_BLOCK_LIMIT;
}

/**
 * 判定是否应该用 highlightAuto
 * 仅 ≤5k 的代码块才用 highlightAuto
 */
export function shouldUseHighlightAuto(codeText: string): boolean {
  return codeText.length <= THRESHOLDS.HIGHLIGHT_AUTO_LIMIT;
}

/**
 * 判定是否需要在读盘前弹确认框
 */
export function shouldConfirmBeforeOpen(byteSize: number): boolean {
  return byteSize > THRESHOLDS.LARGE_FILE_CONFIRM;
}
