import type { DiagnosticDto } from '../api/types';
import { stripAnsi } from './ansi';

// MSBuild / compiler lines: C:\src\Program.cs(12,5): error CS1002: ; expected [C:\src\App.csproj]
const LINE = /^\s*(.+?)\((\d+),(\d+)(?:,(\d+),(\d+))?\)\s*:\s*(error|warning)\s+([A-Za-z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]+\])?\s*$/;

export function parseBuildDiagnostics(output: string): DiagnosticDto[] {
  const seen = new Set<string>();
  const list: DiagnosticDto[] = [];
  for (const raw of stripAnsi(output).split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const key = `${m[1]}|${m[2]}|${m[3]}|${m[7]}|${m[8]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = Number(m[2]);
    const col = Number(m[3]);
    list.push({
      path: m[1].trim(),
      range: { startLine: line, startColumn: col, endLine: m[4] ? Number(m[4]) : line, endColumn: m[5] ? Number(m[5]) : col + 1 },
      severity: m[6] as 'error' | 'warning',
      code: m[7],
      message: m[8],
      unnecessary: false,
    });
  }
  return list;
}

/** "path(line,col)" fragments inside a line of output, for clickable links. */
export const LOCATION_RE = /([A-Za-z]:\\[^():*?"<>|\r\n]+?|\/[^():*?"<>|\r\n]+?)\((\d+),(\d+)(?:,\d+,\d+)?\)/g;
