// Project Properties (Rider's): the .csproj settings in a dialog shaped like Settings. The engine edits the file in
// place (comments and layout kept); an emptied field removes the property. References apply at once, the rest on
// Apply / OK. Also the solution's Add Existing Project and Remove from Solution.
import { AppWindow, FileCog, Hammer, LoaderCircle, Package, Plus, Trash2, Waypoints, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { create } from 'zustand';
import { api, errorText } from '../api/client';
import type { ProjectDto } from '../api/types';
import { basename, samePath } from '../lib/paths';
import { platform } from '../platform';
import { askConfirm, toast, useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';
import type { MenuItem } from './common/Menu';
import { Card, Row, Segmented, Select } from './settings/controls';
import './settings/settings.css';
import './projectProps.css';

interface ProjectReference {
  include: string;
  path: string;
  name: string;
  exists: boolean;
}

interface ProjectProperties {
  path: string;
  name: string;
  sdk?: string;
  properties: Record<string, string>;
  inherited: Record<string, string>;
  inheritedFrom?: string;
  projectReferences: ProjectReference[];
  packageReferences: { id: string; version?: string; central?: boolean }[];
  frameworkReferences: string[];
}

type Tab = 'application' | 'build' | 'package' | 'references';

export const useProjectProperties = create<{ path: string | null }>(() => ({ path: null }));

export function openProjectProperties(path: string): void {
  useProjectProperties.setState({ path });
}

const TFMS = ['net10.0', 'net9.0', 'net8.0', 'net7.0', 'net6.0', 'netstandard2.1', 'netstandard2.0', 'net481', 'net48', 'net472', 'net10.0-windows', 'net9.0-windows', 'net8.0-windows'];
const LANG_VERSIONS = ['latest', 'latestMajor', 'preview', 'default', '14', '13', '12', '11', '10', '9.0', '8.0', '7.3'];

type FieldKind = 'text' | 'bool' | 'long';

interface Field {
  key: string;
  label: string;
  hint?: string;
  kind?: FieldKind;
  options?: [string, string][];
  suggestions?: string[];
  placeholder?: string;
}

const BUILD: Field[] = [
  { key: 'Nullable', label: 'Nullable reference types', options: [['enable', 'Enable'], ['disable', 'Disable'], ['warnings', 'Warnings only'], ['annotations', 'Annotations only']] },
  { key: 'ImplicitUsings', label: 'Implicit global usings', options: [['enable', 'Enable'], ['disable', 'Disable']] },
  { key: 'LangVersion', label: 'Language version', suggestions: LANG_VERSIONS, placeholder: 'default for the framework' },
  { key: 'TreatWarningsAsErrors', label: 'Treat warnings as errors', kind: 'bool' },
  { key: 'WarningsAsErrors', label: 'Specific warnings as errors', hint: 'Codes separated by ;', placeholder: 'CS8600;CS8602' },
  { key: 'NoWarn', label: 'Suppress warnings', hint: 'NoWarn: codes separated by ;', placeholder: '$(NoWarn);CS1591' },
  { key: 'DefineConstants', label: 'Conditional compilation symbols', hint: 'DefineConstants: separated by ;', placeholder: '$(DefineConstants);MY_SYMBOL' },
  { key: 'AllowUnsafeBlocks', label: 'Allow unsafe code', kind: 'bool' },
  { key: 'GenerateDocumentationFile', label: 'Generate XML documentation file', kind: 'bool' },
  { key: 'InvariantGlobalization', label: 'Invariant globalization', hint: 'No culture data at run time', kind: 'bool' },
  { key: 'EnforceCodeStyleInBuild', label: 'Enforce code style in build', kind: 'bool' },
  { key: 'Deterministic', label: 'Deterministic build', kind: 'bool' },
  { key: 'PublishAot', label: 'Native AOT on publish', kind: 'bool' },
];

const PACKAGE: Field[] = [
  { key: 'PackageId', label: 'Package ID', placeholder: 'the assembly name' },
  { key: 'Version', label: 'Version', placeholder: '1.0.0' },
  { key: 'Authors', label: 'Authors' },
  { key: 'Company', label: 'Company' },
  { key: 'Description', label: 'Description', kind: 'long' },
  { key: 'PackageLicenseExpression', label: 'License expression', placeholder: 'MIT', suggestions: ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'GPL-3.0-only', 'LGPL-3.0-only', 'MPL-2.0'] },
  { key: 'RepositoryUrl', label: 'Repository URL', placeholder: 'https://github.com/…' },
  { key: 'PackageProjectUrl', label: 'Project URL' },
  { key: 'PackageTags', label: 'Tags', hint: 'Separated by ;' },
  { key: 'GeneratePackageOnBuild', label: 'Generate package on build', kind: 'bool' },
  { key: 'IsPackable', label: 'Packable', kind: 'bool' },
];

export function ProjectPropertiesDialog() {
  const path = useProjectProperties((s) => s.path);
  if (!path) return null;
  return <Inner key={path} path={path} />;
}

function Inner({ path }: { path: string }) {
  const projects = useWorkspace((s) => s.ws.projects);
  const [data, setData] = useState<ProjectProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>('application');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<ProjectProperties>('/project/properties', { path }).then(
      (d) => {
        setData(d);
        setDraft(d.properties);
      },
      (e) => setError(errorText(e)),
    );
  }, [path]);

  const original = data?.properties ?? {};
  const changes = Object.fromEntries(
    [...new Set([...Object.keys(original), ...Object.keys(draft)])]
      .filter((k) => (draft[k] ?? '').trim() !== (original[k] ?? '').trim())
      .map((k) => [k, (draft[k] ?? '').trim() || null]),
  );
  const dirty = Object.keys(changes).length > 0;
  const get = (k: string) => draft[k] ?? '';
  const put = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));

  const save = async (): Promise<boolean> => {
    if (!dirty) return true;
    setBusy(true);
    try {
      const d = await api.post<ProjectProperties>('/project/properties', { path, set: changes });
      setData(d);
      setDraft(d.properties);
      toast('success', `Saved ${basename(path)}`, 'The projects reload with the new settings');
      return true;
    } catch (e) {
      toast('error', 'Could not save the project file', errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (dirty) {
      const r = await askConfirm({ title: 'Unsaved changes', message: `Save the changes to ${basename(path)}?`, okLabel: 'Save', altLabel: "Don't Save" });
      if (r === 'cancel' || (r === 'ok' && !(await save()))) return;
    }
    useProjectProperties.setState({ path: null });
  };

  /** Reference edits are written at once; the unsaved property edits stay in the draft. */
  const edit = async (url: string, body: object, failure: string) => {
    setBusy(true);
    try {
      setData(await api.post<ProjectProperties>(url, { path, ...body }));
    } catch (e) {
      toast('error', failure, errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const tabs: { id: Tab; label: string; icon: ReactNode; description: string }[] = [
    { id: 'application', label: 'Application', icon: <AppWindow size={16} />, description: 'Assembly, namespace, output and target frameworks.' },
    { id: 'build', label: 'Build', icon: <Hammer size={16} />, description: 'Compiler options, warnings and symbols.' },
    { id: 'package', label: 'Package', icon: <Package size={16} />, description: 'NuGet package metadata (dotnet pack).' },
    { id: 'references', label: 'References', icon: <Waypoints size={16} />, description: 'Projects, packages and frameworks this project uses.' },
  ];
  const current = tabs.find((t) => t.id === tab)!;

  const field = (f: Field) => {
    const id = `pp-${f.key}`;
    const inherited = data?.inherited[f.key];
    const hint = inherited !== undefined && !get(f.key) ? <>{f.hint ? `${f.hint} · ` : ''}Inherited from Directory.Build.props: <code>{inherited}</code></> : f.hint;
    const keywords = f.key;
    if (f.kind === 'bool' || f.options) {
      const opts: [string, string][] = f.options ?? [['true', 'Yes'], ['false', 'No']];
      return (
        <Row key={f.key} label={f.label} htmlFor={id} hint={hint} keywords={keywords}>
          <Select id={id} value={get(f.key)} options={[['', inherited !== undefined ? `Inherited (${inherited})` : 'Default'], ...opts, ...(get(f.key) && !opts.some(([v]) => v === get(f.key)) ? [[get(f.key), get(f.key)] as [string, string]] : [])]} onChange={(v) => put(f.key, v)} />
        </Row>
      );
    }
    if (f.kind === 'long') {
      return (
        <Row key={f.key} label={f.label} htmlFor={id} hint={hint} keywords={keywords} stacked>
          <textarea id={id} className="input pp-textarea" value={get(f.key)} placeholder={inherited ?? f.placeholder} onChange={(e) => put(f.key, e.target.value)} />
        </Row>
      );
    }
    return (
      <Row key={f.key} label={f.label} htmlFor={id} hint={hint} keywords={keywords}>
        <input id={id} className="input pp-input" value={get(f.key)} placeholder={inherited ?? f.placeholder} list={f.suggestions ? `${id}-list` : undefined} spellCheck={false} onChange={(e) => put(f.key, e.target.value)} />
        {f.suggestions && (
          <datalist id={`${id}-list`}>
            {f.suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        )}
      </Row>
    );
  };

  const body = () => {
    if (!data) return null;
    if (tab === 'application') return <ApplicationTab data={data} get={get} put={put} field={field} />;
    if (tab === 'build') return <Card title="Compiler">{BUILD.map(field)}</Card>;
    if (tab === 'package') return <Card title="NuGet package">{PACKAGE.map(field)}</Card>;
    return <ReferencesTab data={data} projects={projects} busy={busy} edit={edit} onNuget={() => void close().then(() => useUi.getState().showBottom('nuget'))} />;
  };

  return (
    <Dialog
      title="Project Properties"
      onClose={() => void close()}
      width={900}
      className="settings-dialog pp-dialog"
      footer={
        <>
          {data?.inheritedFrom && <span className="muted" title={data.inheritedFrom}>Also uses {basename(data.inheritedFrom)}</span>}
          <div className="flex-1" />
          <button className="btn" onClick={() => void close()}>
            Cancel
          </button>
          <button className="btn" disabled={!dirty || busy} onClick={() => void save()}>
            Apply
          </button>
          <button className="btn btn-primary" disabled={busy || !data} onClick={() => void save().then((ok) => ok && useProjectProperties.setState({ path: null }))}>
            OK
          </button>
        </>
      }
    >
      <div className="settings-shell">
        <aside className="settings-side">
          <div className="settings-side-head">
            <span className="settings-side-icon" aria-hidden="true">
              <FileCog size={16} />
            </span>
            <span className="settings-side-title" title={path}>
              {data?.name ?? basename(path).replace(/\.csproj$/i, '')}
            </span>
          </div>
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Project property pages">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={`settings-nav-item${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
                <span className="settings-nav-icon" aria-hidden="true">
                  {t.icon}
                </span>
                <span className="settings-nav-label">{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="settings-side-foot" title={path}>
            {basename(path)}
          </div>
        </aside>
        <main className="settings-main" role="tabpanel" aria-label={current.label}>
          <header className="settings-main-head">
            <h2 className="settings-main-title">{current.label}</h2>
            <p className="settings-main-desc">{current.description}</p>
          </header>
          <div className="settings-scroll">
            {error ? (
              <div className="sev-error">{error}</div>
            ) : !data ? (
              <div className="panel-empty">
                <LoaderCircle size={16} className="spin" /> Reading {basename(path)}…
              </div>
            ) : (
              body()
            )}
          </div>
        </main>
      </div>
    </Dialog>
  );
}

function ApplicationTab({ data, get, put, field }: { data: ProjectProperties; get: (k: string) => string; put: (k: string, v: string) => void; field: (f: Field) => ReactNode }) {
  const multi = !!get('TargetFrameworks') || (!get('TargetFramework') && !!data.inherited.TargetFrameworks);
  const list = get('TargetFrameworks').split(';').map((s) => s.trim()).filter(Boolean);
  const [adding, setAdding] = useState('');
  const setMulti = (m: boolean) => {
    if (m === multi) return;
    if (m) {
      put('TargetFrameworks', get('TargetFramework') || 'net10.0');
      put('TargetFramework', '');
    } else {
      put('TargetFramework', list[0] ?? 'net10.0');
      put('TargetFrameworks', '');
    }
  };
  const add = () => {
    const v = adding.trim();
    if (v && !list.includes(v)) put('TargetFrameworks', [...list, v].join(';'));
    setAdding('');
  };
  return (
    <>
      <Card title="Assembly">
        {field({ key: 'AssemblyName', label: 'Assembly name', placeholder: data.name })}
        {field({ key: 'RootNamespace', label: 'Root namespace', placeholder: data.name })}
        {field({ key: 'OutputType', label: 'Output type', options: [['Exe', 'Console application (Exe)'], ['WinExe', 'Windows application (WinExe)'], ['Library', 'Class library']] })}
        {field({ key: 'StartupObject', label: 'Startup object', hint: 'The class with Main, when there are several', placeholder: 'automatic' })}
      </Card>
      <Card title="Target framework">
        <Row label="Targets" hint={multi ? 'TargetFrameworks: built once per framework' : 'TargetFramework'}>
          <Segmented label="Targets" value={multi ? 'multi' : 'single'} options={[{ value: 'single', label: 'Single' }, { value: 'multi', label: 'Multiple' }]} onChange={(v) => setMulti(v === 'multi')} />
        </Row>
        {multi ? (
          <Row label="Frameworks" htmlFor="pp-tfm-add" hint={!list.length && data.inherited.TargetFrameworks ? `Inherited: ${data.inherited.TargetFrameworks}` : undefined}>
            <div className="pp-chips">
              {list.map((t) => (
                <span key={t} className="pp-chip">
                  {t}
                  <button type="button" aria-label={`Remove ${t}`} onClick={() => put('TargetFrameworks', list.filter((x) => x !== t).join(';'))}>
                    <X size={12} />
                  </button>
                </span>
              ))}
              <input id="pp-tfm-add" className="input settings-text" list="pp-tfm-list" value={adding} placeholder="Add…" spellCheck={false} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} onBlur={add} />
            </div>
          </Row>
        ) : (
          <Row label="Framework" htmlFor="pp-tfm" hint={!get('TargetFramework') && data.inherited.TargetFramework ? `Inherited: ${data.inherited.TargetFramework}` : undefined}>
            <input id="pp-tfm" className="input pp-input" list="pp-tfm-list" value={get('TargetFramework')} placeholder={data.inherited.TargetFramework ?? 'net10.0'} spellCheck={false} onChange={(e) => put('TargetFramework', e.target.value)} />
          </Row>
        )}
        <datalist id="pp-tfm-list">
          {TFMS.filter((t) => !list.includes(t)).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <Row label="SDK" hint="Set on the Project element">
          <span className="muted">{data.sdk ?? 'none (legacy project)'}</span>
        </Row>
      </Card>
    </>
  );
}

function ReferencesTab({ data, projects, busy, edit, onNuget }: { data: ProjectProperties; projects: ProjectDto[]; busy: boolean; edit: (url: string, body: object, failure: string) => Promise<void>; onNuget: () => void }) {
  const candidates = projects.filter((p) => !samePath(p.path, data.path) && !data.projectReferences.some((r) => samePath(r.path, p.path)));
  const [pick, setPick] = useState('');
  const chosen = candidates.find((p) => p.path === pick)?.path ?? candidates[0]?.path ?? '';
  return (
    <>
      <Card title="Project references">
        <div className="pp-list">
          {data.projectReferences.length === 0 && <div className="pp-empty">No project references.</div>}
          {data.projectReferences.map((r) => (
            <div key={r.include} className="pp-item" title={r.path}>
              <span className="pp-item-name">{r.name}</span>
              <span className="pp-item-detail">
                {r.include}
                {!r.exists && ' (missing)'}
              </span>
              <button className="icon-btn sm" title={`Remove the reference to ${r.name}`} disabled={busy} onClick={() => void edit('/project/references/remove', { reference: r.include }, 'Could not remove the reference')}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
        {candidates.length > 0 && (
          <div className="pp-add">
            <Select id="pp-ref-add" value={chosen} options={candidates.map((p) => [p.path, p.name] as [string, string])} onChange={setPick} />
            <button className="btn btn-xs" disabled={busy || !chosen} onClick={() => void edit('/project/references/add', { reference: chosen }, 'Could not add the reference')}>
              <Plus size={13} /> Add Reference
            </button>
          </div>
        )}
      </Card>
      <Card
        title="NuGet packages"
        description={
          <button className="btn btn-xs" onClick={onNuget}>
            <Package size={13} /> Manage NuGet Packages…
          </button>
        }
      >
        <div className="pp-list">
          {data.packageReferences.length === 0 && <div className="pp-empty">No package references.</div>}
          {data.packageReferences.map((p) => (
            <div key={p.id} className="pp-item">
              <span className="pp-item-name">{p.id}</span>
              <span className="pp-item-detail">
                {p.version ?? '?'}
                {p.central && ' (central)'}
              </span>
              <button className="icon-btn sm" title={`Remove ${p.id}`} disabled={busy} onClick={() => void edit('/project/packages/remove', { id: p.id }, 'Could not remove the package')}>
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Framework references" description="Shared frameworks beyond the SDK's own (read-only).">
        <div className="pp-list">
          {data.frameworkReferences.length === 0 && <div className="pp-empty">None beyond the SDK{data.sdk ? ` (${data.sdk})` : ''}.</div>}
          {data.frameworkReferences.map((f) => (
            <div key={f} className="pp-item">
              <span className="pp-item-name">{f}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

// ------------------------------------------------------------------ the solution

const isSolution = (path: string | undefined | null): path is string => !!path && /\.slnx?$/i.test(path);

export async function addExistingProject(solution: string): Promise<void> {
  const project = await platform.pickFile('Add existing project', [{ name: 'C# projects', extensions: ['csproj'] }]);
  if (!project) return;
  try {
    await api.post('/solution/add', { solution, project });
    toast('success', `Added ${basename(project)} to ${basename(solution)}`);
  } catch (e) {
    toast('error', 'Could not add the project', errorText(e));
  }
}

export async function removeFromSolution(solution: string, project: string): Promise<void> {
  const r = await askConfirm({ title: 'Remove from Solution', message: `Remove ${basename(project)} from ${basename(solution)}? The project's files stay on disk.`, okLabel: 'Remove', danger: true });
  if (r !== 'ok') return;
  try {
    await api.post('/solution/remove', { solution, project });
    toast('success', `Removed ${basename(project)} from ${basename(solution)}`);
  } catch (e) {
    toast('error', 'Could not remove the project', errorText(e));
  }
}

/** The Explorer's context menu items of a project node. */
export function projectMenuItems(project: ProjectDto): MenuItem[] {
  const sln = useWorkspace.getState().ws.target;
  return [
    'separator',
    { label: 'Properties…', icon: <FileCog size={14} />, run: () => openProjectProperties(project.path) },
    ...(isSolution(sln) ? [{ label: 'Remove from Solution', run: () => void removeFromSolution(sln, project.path) } as MenuItem] : []),
  ];
}

/** The Explorer's context menu items of a .sln / .slnx node. */
export function solutionMenuItems(solution: string): MenuItem[] {
  const projects = useWorkspace.getState().ws.projects;
  return [
    'separator',
    { label: 'Add Existing Project…', icon: <Plus size={14} />, run: () => void addExistingProject(solution) },
    ...(projects.length ? [{ label: 'Remove Project from Solution', submenu: projects.map((p) => ({ label: p.name, run: () => void removeFromSolution(solution, p.path) })) } as MenuItem] : []),
  ];
}
