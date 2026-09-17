/**
 * 组合根：把数据库、领域 module 与 HTTP 适配层装在一起。
 *
 * 只有这里决定用哪个数据库、按什么顺序接线。测试因此可以
 * createApp({ dbPath: ':memory:' }) 拿到一套完全独立、互不干扰的实例 ——
 * 这正是把「创建依赖」换成「接受依赖」换来的东西。
 */
import { openDb } from './db.js';
import { createColors } from './colors.js';
import { createItems } from './items.js';
import { createSessions } from './auth.js';
import { createAccounts } from './accounts.js';
import { createApi } from './routes.js';

export function createApp({ dbPath }) {
  const store = openDb(dbPath);
  const colors = createColors(store);
  const items = createItems(store, colors);
  const sessions = createSessions(store);
  const accounts = createAccounts(store, items);
  const { handleApi } = createApi({ items, accounts, sessions });

  return {
    store,
    items,
    accounts,
    sessions,
    handleApi,
    close: () => store.close(),
  };
}
