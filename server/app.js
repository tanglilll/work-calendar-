/**
 * 组合根：把数据库、领域 module 与 HTTP 适配层装在一起。
 *
 * 只有这里决定用哪个数据库、按什么顺序接线。测试因此可以
 * createApp({ dbPath: ':memory:' }) 拿到一套完全独立、互不干扰的实例 ——
 * 这正是把「创建依赖」换成「接受依赖」换来的东西。
 * 广播中枢（sse）同样在这里创建：连接表是实例状态，不能是模块状态。
 */
import { openDb } from './db.js';
import { createColors } from './colors.js';
import { createItems } from './items.js';
import { createInvites } from './invites.js';
import { createSessions } from './auth.js';
import { createAccounts } from './accounts.js';
import { createSse } from './sse.js';
import { createApi } from './routes.js';

export function createApp({ dbPath }) {
  const store = openDb(dbPath);
  const colors = createColors(store);
  const items = createItems(store, colors);
  const invites = createInvites(store, items);
  const sessions = createSessions(store);
  const accounts = createAccounts(store, items, invites);
  // 广播中枢也由这里创建：每个实例各持一套连接表。
  // viewer 的权威来源同样在这里接线：中枢在【推送时】问 accounts 要角色，
  // 连接里不存 role 副本 —— 降权之后旧连接立刻按新角色判（工单 04）。
  const sse = createSse({ roleOf: (accountId) => accounts.roleOf(accountId) });
  const { handleApi } = createApi({ items, accounts, sessions, invites, sse });

  return {
    store,
    items,
    accounts,
    invites,
    sessions,
    sse,
    handleApi,
    close: () => {
      sse.closeAll();
      store.close();
    },
  };
}
