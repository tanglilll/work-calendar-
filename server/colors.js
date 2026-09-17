/**
 * 颜色分配。事项的颜色由系统全自动分配，不接受手选。
 */
import { PALETTE } from './config.js';

/**
 * 为新建事项挑色：优先挑当前未被任何未归档事项占用的颜色；
 * 若 12 色全被占用，退回「使用次数最少」的那一色（并列时取索引最小）。
 * 归档会释放它占用的颜色（归档事项不计入统计）。
 */
export function createColors(store) {
  function pickColor() {
    const rows = store.db
      .prepare('SELECT color, COUNT(*) AS n FROM items WHERE archived_at IS NULL GROUP BY color')
      .all();

    const counts = new Array(PALETTE.length).fill(0);
    for (const row of rows) {
      if (Number.isInteger(row.color) && row.color >= 0 && row.color < counts.length) {
        counts[row.color] = Number(row.n);
      }
    }

    const free = counts.indexOf(0);
    if (free !== -1) return free;

    let best = 0;
    for (let i = 1; i < counts.length; i += 1) {
      if (counts[i] < counts[best]) best = i;
    }
    return best;
  }

  return { pickColor };
}
