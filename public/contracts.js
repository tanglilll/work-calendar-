/**
 * 对话框的交互契约：动作词、开框仪式、结果呈现各只有一处定义。
 *
 * 这三种约定以前在每个对话框里各抄一份——✕ 按钮在 itemform 叫 cancel、在 admin / invites 叫
 * close；「先关、再重建内容、再 showModal」三份副本；失败一处由 items-flow 的 result 对象统一
 * 呈现、一处由 admin 在 catch 里按状态码决定要不要重画。抄本之间没有共同判据，只能靠「记得对齐」。
 *
 * 这里不只是把字符串挪个位置：产出端（actAttr）与消费端（readAct / runAct）引用同一个词表，
 * test/contracts.test.js 会在任何一处写回字符串字面量时变红——断言的存在才是收敛。
 */
import { bindDialogForThisOpen } from './dialog.js';

/**
 * 对话框里所有按钮的动作词：值出现在 DOM 的 data-act 属性上，键是本模块与对话框内部用的名字。
 *
 * 同一件事只有一个词：「关掉对话框」（✕、「取消」、「关闭」）在三个对话框里都是 close。
 * 词表是穷举的——每个词至少有一处产出、也有一个处理器，两头都由 test/contracts.test.js 核。
 */
export const DIALOG_ACT = Object.freeze({
  /** 关掉对话框：三个对话框头部的 ✕，以及 itemform 底部的「取消」。 */
  close: 'close',
  save: 'save',
  archive: 'archive',
  /** 删除事项（与归档相对）。 */
  remove: 'delete',
  invite: 'invite',
  /** admin 转移视图里的「取消」：退出转移视图、回账号列表。 */
  cancelTransfer: 'cancel-transfer',
});

const ACT_ATTR = 'data-act';

/** 产出端：把动作词写成属性。属性名与词表都只在这里出现，模板里写回字符串字面量没有落点。 */
export function actAttr(act) {
  return `${ACT_ATTR}="${act}"`;
}

/** 消费端：从被点元素上读出动作词；不是动作按钮就给 null。 */
export function readAct(el) {
  const target = el.closest?.(`[${ACT_ATTR}]`);
  return target ? target.getAttribute(ACT_ATTR) : null;
}

/** 按词表查处理器并执行。未知动作词安静跳过——产出的词都查得到，查不到说明词表与处理器脱节。 */
export function runAct(handlers, act) {
  return Object.hasOwn(handlers, act) ? handlers[act]() : undefined;
}

/**
 * 打开对话框的仪式，只有这一处：已经开着就先关掉（<dialog> 开着时再 showModal 会抛错），
 * 重建内容，按「这一次打开」注册监听（见 dialog.js），再 showModal。
 * onOpen 在打开之后做「开了才做得了」的事：聚焦、初次渲染。
 */
export function openDialog(dialog, { html, listeners = {}, onOpen } = {}) {
  if (dialog.open) dialog.close();
  if (html !== undefined) dialog.innerHTML = html;
  bindDialogForThisOpen(dialog, listeners);
  dialog.showModal();
  onOpen?.(dialog);
}

/**
 * 结果对象 → 呈现。对话框的操作结果只有这一条呈现路径，成功与失败同形：
 * - fields  → 表单字段错误（itemform）；
 * - message → 错误提示；
 * - toast   → 信息提示；
 * - refresh → 重新拉取并重画（admin 面板、邀请列表）；
 * - close   → 关掉对话框并通知应用层刷新（items-flow 的保存成功与版本冲突）；
 * - done    → 通知应用层刷新，但不关框（admin 的成功操作、回应邀请）；
 * 空结果（用户取消了二次确认）什么都不做。
 */
export async function presentResult(result, ui) {
  if (result.fields) ui.setFieldErrors?.(result.fields);
  if (result.message) ui.toast(result.message, 'error');
  if (result.toast) ui.toast(result.toast);
  if (result.refresh) {
    // 重画失败也要说出来：否则界面停在不一致的状态上，而用户以为操作成功了
    try {
      await ui.refresh();
    } catch (err) {
      ui.toast(err.message, 'error');
    }
  }
  if (result.close) {
    ui.close();
    ui.done?.();
  } else if (result.done) {
    await ui.done?.();
  }
}

/**
 * HTTP 错误 → 结果对象，与 items-flow 返回的 result 同一种形状。
 *
 * refresh 这一位是「屏幕上的副本可能已经过期，要重读」：版本冲突（409）与请求因状态已变而无效（400）。
 * 它过去是 admin 的 catch 里手写的条件，现在它是结果上的数据——构造只有这一处，
 * 呈现层不做任何状态码判断。
 */
export function failureResult(err) {
  return {
    ok: false,
    message: err.message,
    fields: err.fields,
    refresh: err.status === 409 || err.status === 400,
  };
}

/** 执行一次操作并归一成结果对象：抛出的错误走 failureResult，返回的结果原样通过。 */
export async function outcomeOf(action) {
  try {
    return await action();
  } catch (err) {
    return failureResult(err);
  }
}
