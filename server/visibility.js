/**
 * 可见性与角色 —— 全应用唯一的「谁能看见 / 处置哪些事项」判据。
 *
 * 三级角色逐级包含（见 CONTEXT.md「角色」）：user 只及于自己的事项；
 * manager 及于全部事项；admin 另有账号管理与归档查看。前端不被信任，
 * 这里的结果是唯一权威——路由层与 SSE 都问这里，不自己写谓词。
 *
 * 粗粒度看 capabilitiesOf，逐条事项看 canAccessItem，SQL 过滤用 ownerScope，
 * 推送过滤用 canReceiveEvent。
 */
const ROLES = ['user', 'manager', 'admin'];

export { ROLES };

/**
 * 账号的能力集。这是前端唯一该知道的东西——bootstrap 把它原样下发，
 * 前端据此渲染，而不是自己比对角色字符串（那样等于把权限规则抄一遍）。
 */
export function capabilitiesOf(account) {
  const managesAccounts = account?.role === 'admin';
  const manager = managesAccounts || account?.role === 'manager';
  return {
    /** 全事项视野：能看见所有人的事项（CONTEXT.md 里「管理员」的口语含义） */
    seesAllItems: manager,
    /** 能替他人建事项、能改事项的 owner */
    assignsOwner: manager,
    /** 账号管理 + 归档查看（admin 独占） */
    managesAccounts,
  };
}

/**
 * 能否读/改/归档/删这一条事项。读与写刻意用同一条规则：
 * 今天它们不分叉，若将来要分（例如只读共享），这里是唯一的判断点。
 */
export function canAccessItem(account, item) {
  if (capabilitiesOf(account).seesAllItems) return true;
  return item.owner_id === account.id;
}

/**
 * listItems 的 owner 过滤片段：让 SQL 层的过滤与内存里的判据同源，
 * 不出现「列表查得出来但改不动」这种不一致。
 */
export function ownerScope(account) {
  if (capabilitiesOf(account).seesAllItems) return { sql: '', params: [] };
  return { sql: ' AND i.owner_id = ?', params: [account.id] };
}

/**
 * SSE：这条事件该不该推给这个客户端。
 * 这是「服务端过滤」的落点——user 绝不能收到他人的事项事件。
 * viewer 需要 { role, accountId }；scope==='self' 的事件由调用方按账号定向，不走这里。
 */
export function canReceiveEvent(viewer, event) {
  if (event.scope === 'admin') return capabilitiesOf(viewer).managesAccounts;
  if (event.scope === 'items') {
    return capabilitiesOf(viewer).seesAllItems || event.ownerId === viewer.accountId;
  }
  return false;
}
