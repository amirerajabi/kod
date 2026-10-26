// SQL completion from the data source's schema: in SQL consoles, and inside C# string literals that hold SQL
// (FromSqlRaw / ExecuteSqlRaw / SqlQuery, Dapper's Query / Execute, or any string that starts like a statement).
import { consoleSource, loadSchema, runQuery, useDb, type DataSource, type DbSchema, type DbTable } from '../store/database';
import { pathOfModel } from './models';
import { monaco } from './monaco';

const KEYWORDS = [
  'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'JOIN', 'INNER JOIN', 'LEFT JOIN', 'RIGHT JOIN',
  'FULL JOIN', 'CROSS JOIN', 'ON', 'GROUP BY', 'ORDER BY', 'HAVING', 'DISTINCT', 'AS', 'ASC', 'DESC', 'LIMIT', 'OFFSET', 'TOP', 'UNION', 'UNION ALL',
  'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE', 'DROP TABLE', 'CREATE INDEX', 'PRIMARY KEY', 'FOREIGN KEY',
  'REFERENCES', 'DEFAULT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'WITH', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'COALESCE', 'CAST', 'BEGIN',
  'COMMIT', 'ROLLBACK', 'TRUNCATE TABLE', 'RETURNING', 'OUTPUT', 'MERGE', 'EXEC',
];

function schemaOf(source: DataSource | undefined): DbSchema[] | null {
  if (!source) return null;
  const s = useDb.getState().schemas[source.id];
  if (s === undefined) void loadSchema(source.id);
  return Array.isArray(s) ? s : null;
}

const unquote = (x: string) => x.replace(/[[\]"`]/g, '');

/** Tables named in the statement, by name and alias ("FROM Orders o JOIN Customers AS c"). */
function referenced(text: string, tables: { schema: string; table: DbTable }[]): Map<string, DbTable> {
  const map = new Map<string, DbTable>();
  const re = /\b(?:from|join|update|into)\s+([\w."[\]`]+)(?:\s+(?:as\s+)?(\w+))?/gi;
  for (const m of text.matchAll(re)) {
    const name = unquote(m[1]).split('.').pop()!.toLowerCase();
    const t = tables.find((x) => x.table.name.toLowerCase() === name);
    if (!t) continue;
    map.set(name, t.table);
    const alias = m[2]?.toLowerCase();
    if (alias && !/^(where|on|join|inner|left|right|full|cross|set|values|group|order|limit|select)$/.test(alias)) map.set(alias, t.table);
  }
  return map;
}

/** Completion items for SQL text `before` the caret, in `statement` (the whole statement, for aliases). */
function items(schemas: DbSchema[], before: string, statement: string, range: monaco.IRange, multiSchema: boolean): monaco.languages.CompletionItem[] {
  const K = monaco.languages.CompletionItemKind;
  const tables = schemas.flatMap((s) => s.tables.map((table) => ({ schema: s.name, table })));
  const refs = referenced(statement, tables);
  const dotted = /([\w"[\]`]+)\.\w*$/.exec(before);
  const out: monaco.languages.CompletionItem[] = [];
  const column = (t: DbTable, sort: string) =>
    t.columns.map((c) => ({
      label: { label: c.name, description: `${c.type}${c.primaryKey ? ' PK' : ''}${c.nullable ? '' : ' NOT NULL'}` },
      kind: K.Field,
      detail: t.name,
      insertText: c.name,
      range,
      sortText: sort + c.name,
    }));
  if (dotted) {
    const q = unquote(dotted[1]).toLowerCase();
    const t = refs.get(q) ?? tables.find((x) => x.table.name.toLowerCase() === q)?.table;
    if (t) return column(t, '0');
    // schema.table
    const s = schemas.find((x) => x.name.toLowerCase() === q);
    if (s) return s.tables.map((t2) => ({ label: t2.name, kind: t2.kind === 'view' ? K.Interface : K.Class, insertText: t2.name, range, sortText: '0' + t2.name }));
    return [];
  }
  for (const t of new Set(refs.values())) out.push(...column(t, '0'));
  for (const { schema, table } of tables)
    out.push({ label: { label: table.name, description: multiSchema ? schema : table.kind }, kind: table.kind === 'view' ? K.Interface : K.Class, detail: `${table.kind} ${schema}.${table.name}`, insertText: table.name, range, sortText: '1' + table.name });
  for (const k of KEYWORDS) out.push({ label: k, kind: K.Keyword, insertText: k, range, sortText: '2' + k });
  return out;
}

/** The statement around the caret: between the previous and the next ';' (or the whole text). */
export function statementAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): { text: string; range: monaco.IRange } {
  const all = model.getValue();
  const off = model.getOffsetAt(pos);
  let start = all.lastIndexOf(';', off - 1) + 1;
  let end = all.indexOf(';', off);
  // the caret right after a ';' belongs to the statement it ends
  if (start === off && all[off - 1] === ';') {
    end = off;
    start = all.lastIndexOf(';', off - 2) + 1;
  }
  end = end < 0 ? all.length : end + 1;
  const a = model.getPositionAt(start);
  const b = model.getPositionAt(end);
  return { text: all.slice(start, end).trim(), range: new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column) };
}

/** Ctrl+Enter in a console: the selection, else the statement at the caret. */
export function runConsole(ed: monaco.editor.ICodeEditor, all = false): void {
  const model = ed.getModel();
  const path = pathOfModel(model);
  const sel = ed.getSelection();
  if (!model || !path?.startsWith('kod-sql:') || !sel) return;
  const sql = all ? model.getValue() : !sel.isEmpty() ? model.getValueInRange(sel) : statementAt(model, sel.getPosition()).text;
  void runQuery(path, sql);
}

// ---------------------------------------------------------------- SQL inside C# strings

const SQL_START = /^\s*(select|insert|update|delete|with|merge|exec|execute|create|alter|drop|truncate)\b/i;
const SQL_CALL = /(FromSql(Raw|Interpolated)?|ExecuteSql(Raw|Interpolated)?(Async)?|SqlQuery(Raw)?|Query(First|Single)?(OrDefault)?(Async)?|QueryMultiple(Async)?|Execute(Scalar)?(Async)?|CommandText\s*=|new\s+(Sql|Npgsql|MySql|Sqlite)Command)\s*(<[^>]*>)?\s*\(?\s*\$?@?\$?$/;

/** The string literal the caret is in (its content up to the caret, and the code before it), or null. */
function stringAt(model: monaco.editor.ITextModel, pos: monaco.IPosition): { content: string; prefix: string } | null {
  // raw string literals ("""…""") span lines: an odd number of """ above means we are inside one
  const from = Math.max(1, pos.lineNumber - 60);
  const above = model.getValueInRange(new monaco.Range(from, 1, pos.lineNumber, pos.column));
  const raws = [...above.matchAll(/"{3,}/g)];
  if (raws.length % 2 === 1) {
    const open = raws[raws.length - 1];
    return { content: above.slice(open.index! + open[0].length), prefix: above.slice(Math.max(0, open.index! - 200), open.index) };
  }
  const line = model.getLineContent(pos.lineNumber).slice(0, pos.column - 1);
  let inStr = false;
  let verbatim = false;
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (!inStr) {
      if (ch === '/' && line[i + 1] === '/') return null;
      if (ch === '\'') {
        i += line[i + 1] === '\\' ? 3 : 2; // a char literal
        continue;
      }
      if (ch === '"') {
        inStr = true;
        verbatim = line[i - 1] === '@' || (line[i - 1] === '$' && line[i - 2] === '@');
        start = i + 1;
      }
    } else if (ch === '\\' && !verbatim) i++;
    else if (ch === '"') {
      if (verbatim && line[i + 1] === '"') i++;
      else inStr = false;
    }
  }
  if (!inStr) return null;
  return { content: line.slice(start), prefix: line.slice(0, start - 1).replace(/[$@]+$/, '') };
}

/** The data source used for SQL in code: the one marked for code, else the first. */
export function codeSource(): DataSource | undefined {
  const list = useDb.getState().sources;
  return list.find((s) => s.forCode) ?? list[0];
}

export function registerSql(): void {
  monaco.languages.registerCompletionItemProvider('sql', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      const path = pathOfModel(model);
      if (!path?.startsWith('kod-sql:')) return { suggestions: [] };
      const schemas = schemaOf(consoleSource(path));
      if (!schemas) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      const before = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column));
      return { suggestions: items(schemas, before, statementAt(model, position).text, range, schemas.length > 1) };
    },
  });

  monaco.languages.registerCompletionItemProvider('csharp', {
    triggerCharacters: ['.', ' '],
    provideCompletionItems(model, position) {
      if (!pathOfModel(model) || useDb.getState().sources.length === 0) return { suggestions: [] };
      const s = stringAt(model, position);
      if (!s || !(SQL_START.test(s.content) || SQL_CALL.test(s.prefix.trimEnd()))) return { suggestions: [] };
      const schemas = schemaOf(codeSource());
      if (!schemas) return { suggestions: [] };
      const word = model.getWordUntilPosition(position);
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn };
      return { suggestions: items(schemas, s.content, s.content, range, schemas.length > 1).map((i) => ({ ...i, sortText: '!' + i.sortText })) };
    },
  });
}

/** Whether the caret is inside a C# string literal (snippets stay out of strings). */
export function inCSharpString(model: monaco.editor.ITextModel, pos: monaco.IPosition): boolean {
  return stringAt(model, pos) !== null;
}
