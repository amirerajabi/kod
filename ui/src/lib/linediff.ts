// Line diff (Myers, O((N+M)·D)) between a base text and the editor text, as the change ranges the gutter shows:
// added / modified line ranges in the new text, and the positions where lines were deleted.

export interface LineChange {
  kind: 'added' | 'modified' | 'deleted';
  /** 1-based, in the new text. For 'deleted', the line after which lines were removed (0 = top). */
  start: number;
  end: number;
}

const MAX_D = 4000;

export function diffLines(oldText: string, newText: string): LineChange[] {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  // trim the common head and tail first (most edits are local)
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const A = a.slice(head, a.length - tail);
  const B = b.slice(head, b.length - tail);
  const ops = myers(A, B);
  if (!ops) return A.length || B.length ? [{ kind: 'modified', start: head + 1, end: head + Math.max(1, B.length) }] : [];

  // walk the edit script into hunks of (deleted count, inserted count) at a position in B
  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k] === '=') {
      i++;
      j++;
      k++;
      continue;
    }
    let del = 0;
    let ins = 0;
    const startB = j;
    while (k < ops.length && ops[k] !== '=') {
      if (ops[k] === '-') {
        del++;
        i++;
      } else {
        ins++;
        j++;
      }
      k++;
    }
    const line = head + startB + 1;
    if (ins === 0) changes.push({ kind: 'deleted', start: line - 1, end: line - 1 });
    else changes.push({ kind: del > 0 ? 'modified' : 'added', start: line, end: line + ins - 1 });
  }
  return changes;
}

/** The edit script ('=', '-', '+') or null when the texts differ too much. */
function myers(a: string[], b: string[]): string[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  const off = max + 1;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a.length, b.length, off);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number, off: number): string[] {
  const ops: string[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? k + 1 : k - 1;
    const prevX = v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d > 0) ops.push(x === prevX ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}
