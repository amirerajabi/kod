import { BadgeCheck, LoaderCircle, Package, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorText, isAbort } from '../api/client';
import type { PackageDto, PackageReferenceDto } from '../api/types';
import { onEngineEvent } from '../api/ws';
import { dirname, samePath } from '../lib/paths';
import { runAndWait } from '../store/procs';
import { askConfirm, toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';

const fmt = (n?: number) => (n === undefined ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}K` : String(n));

/** Search nuget.org, add / remove PackageReferences with the dotnet CLI. */
export function NugetPanel() {
  const projects = useWorkspace((s) => s.ws.projects);
  const startup = useWorkspace((s) => s.startup);
  const [project, setProject] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [prerelease, setPrerelease] = useState(false);
  const [results, setResults] = useState<PackageDto[]>([]);
  const [installed, setInstalled] = useState<PackageReferenceDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<Record<string, string>>({});
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    if (!project || !projects.some((p) => samePath(p.path, project))) setProject(startup ?? projects[0]?.path ?? null);
  }, [projects, startup, project]);

  const loadInstalled = useCallback(async () => {
    if (!project) return setInstalled([]);
    try {
      setInstalled(await api.get<PackageReferenceDto[]>('/nuget/installed', { project }));
    } catch {
      setInstalled([]);
    }
  }, [project]);

  useEffect(() => void loadInstalled(), [loadInstalled]);
  useEffect(() => onEngineEvent((e) => e.type === 'fs.changed' && project && e.files.some((f) => samePath(f, project)) && void loadInstalled()), [project, loadInstalled]);

  useEffect(() => {
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        setResults(await api.get<PackageDto[]>('/nuget/search', { q: query, prerelease }, ac.signal));
      } catch (e) {
        if (!isAbort(e)) {
          setResults([]);
          toast('warning', 'NuGet search failed', errorText(e));
        }
      } finally {
        setBusy(false);
      }
    }, query ? 350 : 0);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [query, prerelease]);

  if (projects.length === 0) return <div className="panel-empty">Open a solution or project to manage its NuGet packages.</div>;

  const install = async (p: PackageDto) => {
    if (!project) return;
    const version = versions[p.id] ?? p.version;
    setWorking(p.id);
    const r = await runAndWait({ kind: 'nuget', title: `Add ${p.id} ${version}`, file: 'dotnet', args: ['add', project, 'package', p.id, '--version', version], cwd: dirname(project) });
    setWorking(null);
    if (r?.exitCode === 0) void loadInstalled();
  };

  const remove = async (id: string) => {
    if (!project) return;
    if ((await askConfirm({ title: 'Remove package', message: `Remove ${id} from the project?`, okLabel: 'Remove', danger: true })) !== 'ok') return;
    setWorking(id);
    const r = await runAndWait({ kind: 'nuget', title: `Remove ${id}`, file: 'dotnet', args: ['remove', project, 'package', id], cwd: dirname(project) });
    setWorking(null);
    if (r?.exitCode === 0) void loadInstalled();
  };

  const installedIds = new Set(installed.map((i) => i.id.toLowerCase()));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="panel-header">
        <span className="panel-title">NuGet</span>
      </div>
      <div className="search-form">
        <select className="input sm" value={project ?? ''} onChange={(e) => setProject(e.target.value)} aria-label="Project">
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {p.name}
            </option>
          ))}
        </select>
        <div className="search-row">
          <input className="input sm" placeholder="Search nuget.org" value={query} onChange={(e) => setQuery(e.target.value)} />
          {busy ? <LoaderCircle size={14} className="spin muted" /> : <Search size={14} className="muted" />}
        </div>
        <label className="check" style={{ fontSize: 'var(--text-xs)' }}>
          <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} /> Include prerelease
        </label>
      </div>
      <div className="result-list">
        {installed.length > 0 && (
          <>
            <div className="section-label">Installed ({installed.length})</div>
            {installed.map((p) => (
              <div key={p.id} className="pkg" style={{ cursor: 'default' }}>
                <div className="pkg-icon">
                  <Package size={16} />
                </div>
                <div className="pkg-body">
                  <div className="pkg-name">
                    <span>{p.id}</span>
                    <span className="pkg-ver">{p.version ?? 'central'}</span>
                  </div>
                </div>
                <button className="icon-btn sm" title={`Remove ${p.id}`} disabled={working === p.id} onClick={() => void remove(p.id)}>
                  {working === p.id ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}
                </button>
              </div>
            ))}
          </>
        )}
        <div className="section-label">{query ? 'Search results' : 'Popular'}</div>
        {results.map((p) => (
          <div key={p.id} className={`pkg${selected === p.id ? ' selected' : ''}`} onClick={() => setSelected(selected === p.id ? null : p.id)}>
            <div className="pkg-icon">{p.iconUrl ? <img src={p.iconUrl} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <Package size={16} />}</div>
            <div className="pkg-body">
              <div className="pkg-name">
                <span>{p.id}</span>
                {p.verified && <BadgeCheck size={13} className="text-accent" style={{ color: 'var(--accent)' }} />}
                <span className="pkg-ver">{p.version}</span>
                <span className="pkg-ver" style={{ marginLeft: 'auto' }}>
                  {fmt(p.totalDownloads)}
                </span>
              </div>
              <div className="pkg-desc">{p.description}</div>
              {selected === p.id && (
                <div className="pkg-actions" onClick={(e) => e.stopPropagation()}>
                  <select className="input sm" style={{ width: 140 }} value={versions[p.id] ?? p.version} onChange={(e) => setVersions({ ...versions, [p.id]: e.target.value })}>
                    {(p.versions.length ? p.versions : [p.version]).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                  <button className="btn btn-xs btn-primary" disabled={working === p.id} onClick={() => void install(p)}>
                    {working === p.id ? <LoaderCircle size={12} className="spin" /> : null}
                    {installedIds.has(p.id.toLowerCase()) ? 'Update' : 'Install'}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
