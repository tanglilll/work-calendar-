/**
 * 测试用的最小世界：一套独立的 :memory: 实例 + 三个账号。
 * admin（admin）、zhao 与 lin（user，走真实的申请→批准路径）。
 *
 * 放在 test/ 之外：node --test 会把 test/ 下的每个 .js 都当成测试文件收集，
 * 助手模块放进去会多出一条「零测试通过」的噪声。
 */
import { createApp } from '../server/app.js';

export function freshWorld() {
  const app = createApp({ dbPath: ':memory:' });
  app.accounts.ensureBootstrapAdmin({ username: 'admin', password: 'password-1' });
  const admin = app.accounts.findAccountByUsername('admin');

  const member = (username) => {
    app.accounts.submitRegistrationRequest({ username, password: 'password-2', note: '' });
    const pending = app.accounts.listRequests().find((r) => r.username === username);
    return app.accounts.approveRequest(pending.id).account;
  };

  return { app, admin, zhao: member('zhao'), lin: member('lin') };
}

export const draft = (over = {}) => ({
  title: '写周报',
  event_date: '2026-09-01',
  due_date: '2026-09-01',
  tag: null,
  ...over,
});
