// NoteBoard 大文档分段 Worker
// new Worker(new URL(...), { type: 'module' })
// globalThis.isSpace polyfill
// await import('./sectionDocument')
// 回传时把 source 抹成 ''
// 详见 docs/09-开发路线图.md 11.4/11.5

/// <reference lib="webworker" />

// ProseMirror 的 isSpace polyfill
(globalThis as Record<string, unknown>).isSpace = (ch: string) => {
  if (ch === '') return false;
  const code = ch.charCodeAt(0);
  return code === 32 || code === 9 || code === 10 || code === 13 || code === 160;
};

interface WorkerRequest {
  type: 'split';
  content: string;
  requestId: number;
}

interface WorkerResponse {
  type: 'split-result';
  sections: { index: number; start: number; end: number; content: string }[];
  requestId: number;
  source: ''; // 抹空
}

let initialized = false;
let splitSections: ((content: string) => { index: number; start: number; end: number; content: string }[]) | null = null;

async function ensureInitialized() {
  if (initialized) return;
  initialized = true;

  // 动态导入（Worker 内部）
  const mod = await import('./sectionDocument');
  splitSections = mod.splitSections;
}

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const { type, content, requestId } = e.data;

  if (type === 'split') {
    await ensureInitialized();
    if (!splitSections) {
      const response: WorkerResponse = {
        type: 'split-result',
        sections: [],
        requestId,
        source: '',
      };
      (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
      return;
    }

    const sections = splitSections(content);
    const response: WorkerResponse = {
      type: 'split-result',
      sections,
      requestId,
      source: '', // 抹空
    };
    (self as unknown as DedicatedWorkerGlobalScope).postMessage(response);
  }
};
