/**
 * PROTOTYPE —— 一次性启动器，选完样式就删。
 *
 * 起一个跑在「一次性演示库」上的 rili 实例，并灌入一批演示数据，
 * 让你能看到真实密度下的日历（空日历没法评判样式）。
 *
 *   node prototype/run-calendar-demo.mjs            # 用已有演示库
 *   node prototype/run-calendar-demo.mjs --fresh     # 先删库重建
 *
 * 演示库 data/prototype-calendar.db 与你的 data/browser.db 完全无关。
 * 数据经由真实 HTTP 接口写入（/api/login、/api/register-request、
 * /api/admin/requests/:id/approve、/api/items），因此校验、颜色分配、
 * 权限过滤都走生产路径，不是伪造的。
 */
import { spawn } from 'node:child_process';
import { rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DB = './data/prototype-calendar.db';
const PORT = 4300;
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const ADMIN_USER = 'demo';
const ADMIN_PASSWORD = 'demo-prototype-2026';
const MEMBER_PASSWORD = 'demo-prototype-2026';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function wipeDb() {
  for (const suffix of ['', '-shm', '-wal']) {
    const p = join(ROOT, DB + suffix);
    if (existsSync(p)) rmSync(p);
  }
}

// ---------- 极简 HTTP 客户端（手动带 cookie） ----------

let cookie = '';

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
  if (setCookies.length) cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

// ---------- 日期工具 ----------

const toDate = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function todayStr() {
  return toDate(new Date());
}

function shift(base, days) {
  const [y, m, d] = base.split('-').map(Number);
  return toDate(new Date(y, m - 1, d + days));
}

// ---------- 演示数据 ----------
// 相对「今天」生成，所以任何时候跑都能看到围绕今天的真实密度。
// 刻意覆盖这些边界：跨月、同日多条（触发「+N 项」）、逾期、今天截止、无标签。

function dataset(today) {
  const t = (n) => shift(today, n);
  return [
    // 今天：密度最高的一格（6 条，会触发 4 块上限里的「+N 项」折叠）
    { title: '周会：本周排期', from: t(0), to: t(0), tag: '会议', owner: 'demo' },
    { title: '写交接文档', from: t(0), to: t(0), tag: '工作', owner: 'demo' },
    { title: '体检预约', from: t(0), to: t(0), tag: '个人', owner: 'lin' },
    { title: '修复导出的编码问题', from: t(0), to: t(0), tag: '紧急', owner: 'zhao' },
    { title: '整理需求池', from: t(0), to: t(0), tag: null, owner: 'lin' },
    { title: '回邮件', from: t(0), to: t(0), tag: null, owner: 'zhao' },

    // 单日：围绕今天散开
    { title: '客户对接会', from: t(1), to: t(1), tag: '会议', owner: 'demo' },
    { title: '排下周计划', from: t(1), to: t(1), tag: '工作', owner: 'lin' },
    { title: '代码评审', from: t(2), to: t(2), tag: '工作', owner: 'zhao' },
    { title: '牙医', from: t(2), to: t(2), tag: '个人', owner: 'demo' },
    { title: '季度复盘', from: t(3), to: t(3), tag: '会议', owner: 'lin' },
    { title: '交月报', from: t(4), to: t(4), tag: '工作', owner: 'zhao' },
    { title: '团建', from: t(5), to: t(5), tag: '个人', owner: 'demo' },
    { title: '补测试', from: t(6), to: t(6), tag: '工作', owner: 'lin' },
    { title: '供应商沟通', from: t(7), to: t(7), tag: '出差', owner: 'zhao' },

    // 跨多日：最常见的「一件事铺好几天」
    { title: '版本 1.2 开发', from: t(-2), to: t(4), tag: '工作', owner: 'demo' },
    { title: '安全审计', from: t(1), to: t(6), tag: '工作', owner: 'lin' },
    { title: '出差：杭州', from: t(8), to: t(11), tag: '出差', owner: 'zhao' },
    { title: '培训：新人入职', from: t(-5), to: t(-3), tag: '会议', owner: 'lin' },
    { title: '整理归档旧项目', from: t(9), to: t(13), tag: null, owner: 'demo' },

    // 跨月边界：一段跨到上月末，一段跨到下月初
    { title: '月度结算', from: t(-20), to: t(-16), tag: '工作', owner: 'demo' },
    { title: '跨月：数据迁移', from: t(12), to: t(17), tag: '工作', owner: 'lin' },
    { title: '跨月：假期', from: t(14), to: t(20), tag: '个人', owner: 'zhao' },

    // 逾期（截止已过、未归档）与今天截止
    { title: '提交报销单', from: t(-6), to: t(-4), tag: '工作', owner: 'zhao' },
    { title: '续签合同', from: t(-3), to: t(-1), tag: '紧急', owner: 'demo' },
    { title: '今天必须交的周报', from: t(-2), to: t(0), tag: '紧急', owner: 'lin' },

    // 下个月初，验证翻月后依然连续染色
    { title: '下月启动会', from: t(16), to: t(16), tag: '会议', owner: 'demo' },
    { title: '下月版本冻结', from: t(18), to: t(20), tag: '工作', owner: 'zhao' },
    { title: '下月：外部评审', from: t(21), to: t(23), tag: '会议', owner: 'lin' },
    { title: '下月：预算复核', from: t(24), to: t(25), tag: '工作', owner: 'demo' },
  ];
}

// ---------- 主流程 ----------

if (process.argv.includes('--fresh')) {
  wipeDb();
  console.log('[prototype] 已删除旧演示库，将重建');
}

const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    RILI_DB: DB,
    PORT: String(PORT),
    HOST,
    RILI_ADMIN_USER: ADMIN_USER,
    RILI_ADMIN_PASSWORD: ADMIN_PASSWORD,
  },
  stdio: 'inherit',
});

try {
  // 等就绪
  let ready = false;
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) {
        ready = true;
        break;
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!ready) throw new Error('服务未能在 15 秒内就绪');

  await api('/api/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PASSWORD } });

  const existing = await api('/api/items');
  if (existing.items.length > 0) {
    console.log(`[prototype] 演示库已有 ${existing.items.length} 条事项，跳过种数据（要重来加 --fresh）`);
  } else {
    // 造两个成员账号：申请 → 批准 → 一个提为 manager
    for (const name of ['lin', 'zhao']) {
      await api('/api/register-request', {
        method: 'POST',
        body: { username: name, password: MEMBER_PASSWORD, note: '原型演示账号' },
      });
    }
    const { requests } = await api('/api/admin/requests');
    for (const r of requests) await api(`/api/admin/requests/${r.id}/approve`, { method: 'POST' });
    const { accounts } = await api('/api/admin/accounts');
    const lin = accounts.find((a) => a.username === 'lin');
    if (lin) await api(`/api/admin/accounts/${lin.id}`, { method: 'PATCH', body: { role: 'manager' } });

    const { owners } = await api('/api/owners');
    const byName = new Map(owners.map((o) => [o.username, o.id]));

    const today = todayStr();
    const rows = dataset(today);
    for (const row of rows) {
      await api('/api/items', {
        method: 'POST',
        body: {
          title: row.title,
          event_date: row.from,
          due_date: row.to,
          tag: row.tag,
          owner_id: byName.get(row.owner) ?? byName.get(ADMIN_USER),
        },
      });
    }
    console.log(`[prototype] 已写入 ${rows.length} 条演示事项，围绕「今天」${today}`);
  }

  console.log('\n──────────────────────────────────────────────');
  console.log('  原型已就绪，用浏览器打开：');
  console.log(`  ${BASE}/?variant=A`);
  console.log('');
  console.log(`  登录账号   ${ADMIN_USER} / ${ADMIN_PASSWORD}`);
  console.log(`  成员账号   lin（manager）、zhao（user）—— 密码同上`);
  console.log('');
  console.log('  切换样式：页面底部浮动的 ← → 栏，或直接用 ?variant=A|B|C|D');
  console.log('  按 Ctrl-C 退出（服务会一起停）');
  console.log('──────────────────────────────────────────────\n');
} catch (err) {
  console.error('[prototype] 启动失败：', err.message);
  server.kill();
  process.exit(1);
}

const stop = () => {
  server.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
