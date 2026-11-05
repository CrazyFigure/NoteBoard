import { afterAll } from 'vitest';

// 每个 jsdom 测试环境使用自己的内存存储，防止 Node 的 localStorage 属性抢占浏览器实现。
const testDom = (globalThis as typeof globalThis & {
  jsdom?: { window: { localStorage: Storage } };
}).jsdom;

// 部分测试显式采用 Node 环境，只有存在 jsdom 时才绑定浏览器存储。
if (testDom) {
  // 保存宿主属性描述符，测试环境退出时恢复，避免复用工作进程时遗留已关闭的 jsdom。
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    get: () => testDom.window.localStorage,
  });
  afterAll(() => {
    if (originalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalStorage);
    } else {
      Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
}
