// NoteBoard 文档历史记录：版本正文加载与缓存
// 历史正文不可变（按条目 id 读取），缓存最近查看过的若干版本，来回切换不重复解压

import { useEffect, useState } from 'react';
import * as ipc from '../../core/ipc/commands';

/** 缓存上限：超出后淘汰最早放入的版本 */
const CACHE_LIMIT = 24;
const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string>>();

function cacheKey(path: string, id: string): string {
  return `${path}\u0000${id}`;
}

/** 读取某个版本的正文（合并窗口中的最新版本可能还会变化，不缓存） */
export function loadVersionContent(path: string, id: string, cacheable = true): Promise<string> {
  const key = cacheKey(path, id);
  const hit = cache.get(key);
  if (hit !== undefined) return Promise.resolve(hit);
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = ipc
    .historyRead(path, id)
    .then((result) => {
      if (cacheable) {
        cache.set(key, result.content);
        while (cache.size > CACHE_LIMIT) {
          const oldest = cache.keys().next().value;
          if (oldest === undefined) break;
          cache.delete(oldest);
        }
      }
      return result.content;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** 清除某个文档的缓存（版本被删除或刷新时） */
export function dropVersionContent(path: string, id?: string): void {
  if (id) {
    cache.delete(cacheKey(path, id));
    return;
  }
  for (const key of [...cache.keys()]) {
    if (key.startsWith(`${path}\u0000`)) cache.delete(key);
  }
}

export interface VersionContentState {
  content: string | null;
  loading: boolean;
  error: string | null;
}

/** 组件读取版本正文；id 为空时返回空内容（例如最早版本没有上一版） */
export function useVersionContent(path: string | null, id: string | null, cacheable = true, revision = 0): VersionContentState {
  const [state, setState] = useState<VersionContentState>({ content: null, loading: Boolean(path && id), error: null });
  useEffect(() => {
    if (!path || !id) {
      setState({ content: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((prev) => ({ content: prev.content, loading: true, error: null }));
    loadVersionContent(path, id, cacheable)
      .then((content) => {
        if (alive) setState({ content, loading: false, error: null });
      })
      .catch((error) => {
        if (alive) setState({ content: null, loading: false, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      alive = false;
    };
  }, [path, id, cacheable, revision]);
  return state;
}
