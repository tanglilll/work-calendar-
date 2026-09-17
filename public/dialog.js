/**
 * 对话框的监听器生命周期。
 *
 * 常驻的 <dialog> 元素（index.html 里那两个）会被反复打开，如果把监听器直接挂在
 * 它上面，每开一次就多叠一个——于是点一次「保存」提交 N 次、点一次「标记完成」
 * 弹 N 个确认框（N = 本次页面里开过多少次对话框）。这个 bug 修过一次，这里用
 * 结构把它排除掉：每次调用都先解除上一轮的监听。
 *
 * 用 WeakMap 记住每个 dialog 当前的 controller，所以多个对话框互不干扰，
 * 也不需要模块级可变状态。
 */
const live = new WeakMap();

/**
 * 为「这一次打开」注册监听。传入 { 事件名: 处理函数 }。
 * 再次调用时，上一轮注册的监听会被整体解除。
 */
export function bindDialogForThisOpen(dialog, listeners) {
  live.get(dialog)?.abort();

  const controller = new AbortController();
  live.set(dialog, controller);

  for (const [type, handler] of Object.entries(listeners)) {
    if (handler) dialog.addEventListener(type, handler, { signal: controller.signal });
  }

  return () => controller.abort();
}
