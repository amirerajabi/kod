// User-level actions shared by menus, the palette, the explorer and shortcuts.
import { api, errorText } from '../api/client';
import { getEditor } from '../editor/CodeEditor';
import { basename, dirname, extname, join, relative, stem } from '../lib/paths';
import { platform } from '../platform';
import { useClipboard } from '../store/clipboard';
import { closeAllTabs, useEditors } from '../store/editors';
import { useProblems } from '../store/problems';
import { askConfirm, askText, toast, useUi } from '../store/ui';
import { projectOf, useWorkspace } from '../store/workspace';

export async function openFolder(): Promise<void> {
  const path = await platform.pickFolder('Open folder or solution directory');
  if (path) await openWorkspace(path);
}

export async function openSolutionFile(): Promise<void> {
  const path = await platform.pickFile('Open solution or project', [{ name: 'Solutions and projects', extensions: ['sln', 'slnx', 'csproj'] }]);
  if (path) await openWorkspace(path);
}

export async function openWorkspace(path: string): Promise<void> {
  if (!(await closeAllTabs())) return;
  useProblems.setState({ live: {}, build: [], solution: null });
  await useWorkspace.getState().open(path);
}

export async function closeWorkspace(): Promise<void> {
  if (!(await closeAllTabs())) return;
  useProblems.setState({ live: {}, build: [], solution: null });
  await useWorkspace.getState().close();
}

const INVALID = /[<>:"|?*\u0000-\u001f]/;

function validName(v: string): string | null {
  if (INVALID.test(v)) return 'The name contains characters that are not allowed in file names';
  if (v.endsWith('.') || v.endsWith(' ')) return 'A name cannot end with a dot or a space';
  return null;
}

function validIdentifier(v: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_]*(\.cs)?$/.test(v) ? null : 'Use a C# identifier (letters, digits, underscore)';
}

/** The namespace for a new file: the project's name plus the folders below the project directory. */
export function namespaceFor(dir: string): string {
  const project = projectOf(dir + (dir.includes('\\') ? '\\x' : '/x'));
  const root = project ? dirname(project.path) : useWorkspace.getState().ws.root;
  const base = project ? stem(project.path) : 'App';
  const rel = root ? relative(root, dir) : '';
  const parts = [base, ...rel.split(/[\\/]/).filter(Boolean)].map((p) => p.replace(/[^A-Za-z0-9_.]/g, '_').replace(/^(\d)/, '_$1'));
  return parts.join('.');
}

export type NewKind = 'class' | 'interface' | 'record' | 'enum' | 'struct' | 'file' | 'folder';

export async function createItem(dir: string, kind: NewKind): Promise<void> {
  const titles: Record<NewKind, string> = {
    class: 'New C# class',
    interface: 'New C# interface',
    record: 'New C# record',
    enum: 'New C# enum',
    struct: 'New C# struct',
    file: 'New file',
    folder: 'New folder',
  };
  const isType = kind !== 'file' && kind !== 'folder';
  const name = await askText({
    title: titles[kind],
    label: `In ${relative(useWorkspace.getState().ws.root, dir) || basename(dir)}`,
    placeholder: kind === 'interface' ? 'IMyService' : kind === 'folder' ? 'Folder name' : kind === 'file' ? 'file.json' : 'MyClass',
    okLabel: 'Create',
    validate: isType ? validIdentifier : validName,
  });
  if (!name) return;
  if (kind === 'folder') {
    try {
      await api.post('/fs/create', { path: join(dir, name), isDir: true });
    } catch (e) {
      toast('error', 'Could not create the folder', errorText(e));
    }
    return;
  }
  const typeName = name.replace(/\.cs$/, '');
  const fileName = isType ? `${typeName}.cs` : name;
  const path = join(dir, fileName);
  let text = '';
  let cursor = { line: 1, column: 1 };
  if (isType) {
    const ns = namespaceFor(dir);
    const body =
      kind === 'record'
        ? `public record ${typeName}();\n`
        : kind === 'enum'
          ? `public enum ${typeName}\n{\n    \n}\n`
          : `public ${kind} ${typeName}\n{\n    \n}\n`;
    text = `namespace ${ns};\n\n${body}`;
    cursor = kind === 'record' ? { line: 3, column: 15 + kind.length + typeName.length } : { line: 5, column: 5 };
  } else if (extname(fileName) === '.cs') {
    text = `namespace ${namespaceFor(dir)};\n\n`;
    cursor = { line: 3, column: 1 };
  }
  try {
    await api.post('/fs/create', { path, isDir: false, text });
    await useEditors.getState().open(path, cursor);
  } catch (e) {
    toast('error', `Could not create ${fileName}`, errorText(e));
  }
}

export async function renamePath(path: string, isDir: boolean): Promise<void> {
  const name = basename(path);
  const dot = isDir ? -1 : name.lastIndexOf('.');
  const next = await askText({ title: `Rename ${isDir ? 'folder' : 'file'}`, value: name, select: [0, dot > 0 ? dot : name.length], okLabel: 'Rename', validate: validName });
  if (!next || next === name) return;
  const target = join(dirname(path), next);
  try {
    const res = await api.post<{ path: string }>('/fs/rename', { from: path, to: target });
    useEditors.getState().renamed(path, res.path);
  } catch (e) {
    toast('error', `Could not rename ${name}`, errorText(e));
  }
}

export async function deletePath(path: string, isDir: boolean): Promise<void> {
  const name = basename(path);
  const answer = await askConfirm({
    title: `Delete ${isDir ? 'folder' : 'file'}`,
    message: platform.os === 'win32' ? `Move "${name}" to the Recycle Bin?` : `Delete "${name}"${isDir ? ' and everything in it' : ''}? This cannot be undone.`,
    okLabel: 'Delete',
    danger: true,
  });
  if (answer !== 'ok') return;
  try {
    await api.post('/fs/delete', { path });
    useEditors.getState().deleted(path);
  } catch (e) {
    toast('error', `Could not delete ${name}`, errorText(e));
  }
}

export async function copyText(text: string, what = 'Path'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    useClipboard.getState().add(text);
    toast('info', `${what} copied`, undefined, 1500);
  } catch {
    toast('warning', 'Clipboard is not available');
  }
}

export function goToLine(): void {
  useUi.getState().openPalette('line', ':');
}

export function currentFilePath(): string | null {
  const { active, tabs } = useEditors.getState();
  return tabs.find((t) => t.path === active && t.kind === 'file')?.path ?? null;
}

export function focusEditor(): void {
  getEditor()?.focus();
}
