/**
 * Subsequence fuzzy match. Returns a score (higher is better) and the matched indexes, or null.
 * Rewards consecutive runs, word starts (after . _ - / \ space or a lower→Upper hump) and a match at the start.
 */
export function fuzzy(query: string, target: string): { score: number; hits: number[] } | null {
  if (!query) return { score: 0, hits: [] };
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  const hits: number[] = [];
  let score = 0;
  let ti = 0;
  let run = 0;
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi];
    if (ch === ' ') continue;
    let found = -1;
    // prefer a word start for this character
    for (let k = ti; k < t.length; k++) {
      if (t[k] !== ch) continue;
      if (found < 0) found = k;
      if (isWordStart(target, k)) {
        found = k;
        break;
      }
      if (k === ti) break;
    }
    if (found < 0) return null;
    const consecutive = hits.length > 0 && hits[hits.length - 1] === found - 1;
    run = consecutive ? run + 1 : 0;
    score += 1 + run * 3 + (isWordStart(target, found) ? 6 : 0) + (found === 0 ? 8 : 0);
    hits.push(found);
    ti = found + 1;
  }
  score -= Math.min(20, target.length / 8);
  return { score, hits };
}

function isWordStart(s: string, i: number): boolean {
  if (i === 0) return true;
  const prev = s[i - 1];
  const cur = s[i];
  if ('._-/\\ '.includes(prev)) return true;
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase();
}
