import { AlertTriangle, ArrowUp, BadgeCheck, Download, ExternalLink, LoaderCircle, Minus, Package, Plus, RefreshCw, Search, ShieldAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, errorText, isAbort } from '../api/client';
import { onEngineEvent } from '../api/ws';
import { dirname, samePath } from '../lib/paths';
import { platform } from '../platform';
import { dotnetBuild, runAndWait } from '../store/procs';
import { askConfirm, toast } from '../store/ui';
import { useWorkspace } from '../store/workspace';

interface PackageRow {
  id: string;
  version: string;
  description?: string;
  totalDownloads?: number;
  iconUrl?: string;
  versions: string[];
  verified: boolean;
  authors?: string;
  source?: string;
}

interface ProjectPackages {
  project: string;
  projectPath: string;
  packages: { id: string; version?: string; central?: boolean }[];
}

interface Details {
  id: string;
  version: string;
  title?: string;
  description?: string;
  authors?: string;
  projectUrl?: string;
  licenseExpression?: string;
  licenseUrl?: string;
  published?: string;
  tags?: string;
  dependencyGroups: { targetFramework: string; dependencies: { id: string; range?: string }[] }[];
  deprecation?: string;
  vulnerabilities: string[];
  listed: boolean;
}

interface Source {
  name: string;
  url: string;
  enabled: boolean;
  http: boolean;
}

type View = 'browse' | 'installed' | 'updates';

const fmt = (n?: number) => (n === undefined ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n));

/** Semver-ish compare: numeric parts first, a prerelease sorts before its release. */
function cmp(a: string, b: string): number {
  const [ma, pa = ''] = a.split('-', 2);
  const [mb, pb = ''] = b.split('-', 2);
  const na = ma.split('.').map(Number);
  const nb = mb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return d;
  }
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

/** Rider's NuGet tool window: Packages (browse / installed / updates, details, projects) and Sources. */
export function NugetWindow() {
  const projects = useWorkspace((s) => s.ws.projects);
  const [tab, setTab] = useState<'packages' | 'sources'>('packages');
  const [view, setView] = useState<View>('browse');
  const [query, setQuery] = useState('');
  const [prerelease, setPrerelease] = useState(false);
  const [source, setSource] = useState('');
  const [sources, setSources] = useState<Source[]>([]);
  const [results, setResults] = useState<PackageRow[]>([]);
  const [installed, setInstalled] = useState<ProjectPackages[]>([]);
  const [latest, setLatest] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const loadInstalled = useCallback(async () => {
    try {
      setInstalled(await api.get<ProjectPackages[]>('/nuget/installedAll'));
    } catch {
      setInstalled([]);
    }
  }, []);

  useEffect(() => void loadInstalled(), [loadInstalled, projects]);
  useEffect(() => void api.get<Source[]>('/nuget/sources').then(setSources, () => setSources([])), []);
  // project files edited by dotnet add/remove (or by hand)
  useEffect(() => onEngineEvent((e) => e.type === 'fs.changed' && e.files.some((f) => /\.(csproj|props)$/i.test(f)) && void loadInstalled()), [loadInstalled]);

  const installedIds = useMemo(() => [...new Set(installed.flatMap((p) => p.packages.map((x) => x.id)))].sort((a, b) => a.localeCompare(b)), [installed]);
  const versionsOf = (id: string) => installed.flatMap((p) => p.packages.filter((x) => x.id.toLowerCase() === id.toLowerCase()).map((x) => x.version ?? '?'));

  useEffect(() => {
    if (installedIds.length === 0) return setLatest({});
    void api.post<Record<string, string>>('/nuget/latest', { ids: installedIds, prerelease }).then(setLatest, () => setLatest({}));
  }, [installedIds.join('|'), prerelease]); // eslint-disable-line react-hooks/exhaustive-deps

  const updates = installedIds.filter((id) => latest[id] && versionsOf(id).some((v) => v !== '?' && cmp(latest[id], v) > 0));

  useEffect(() => {
    if (view !== 'browse') return;
    const ac = new AbortController();
    const t = setTimeout(async () => {
      setBusy(true);
      try {
        setResults(await api.get<PackageRow[]>('/nuget/search', { q: query, prerelease, source: source || undefined }, ac.signal));
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
  }, [query, prerelease, source, view]);

  const rows: PackageRow[] = useMemo(() => {
    if (view === 'browse') return results;
    const ids = view === 'updates' ? updates : installedIds;
    const q = query.trim().toLowerCase();
    return ids
      .filter((id) => !q || id.toLowerCase().includes(q))
      .map((id) => results.find((r) => r.id.toLowerCase() === id.toLowerCase()) ?? { id, version: latest[id] ?? versionsOf(id)[0] ?? '', versions: [], verified: false });
  }, [view, results, installedIds, updates, query, latest]); // eslint-disable-line react-hooks/exhaustive-deps

  const runDotnet = async (title: string, project: string, args: string[]) => {
    const r = await runAndWait({ kind: 'nuget', title, file: 'dotnet', args, cwd: dirname(project) });
    return r?.exitCode === 0;
  };

  const install = async (id: string, version: string, targets: string[]) => {
    setWorking(id);
    for (const p of targets) if (!(await runDotnet(`Add ${id} ${version}`, p, ['add', p, 'package', id, '--version', version]))) break;
    setWorking(null);
    await loadInstalled();
  };

  const remove = async (id: string, targets: string[]) => {
    if ((await askConfirm({ title: 'Remove package', message: `Remove ${id} from ${targets.length === 1 ? projects.find((p) => samePath(p.path, targets[0]))?.name : `${targets.length} projects`}?`, okLabel: 'Remove', danger: true })) !== 'ok') return;
    setWorking(id);
    for (const p of targets) if (!(await runDotnet(`Remove ${id}`, p, ['remove', p, 'package', id]))) break;
    setWorking(null);
    await loadInstalled();
  };

  const updateAll = async () => {
    if (!updates.length) return;
    if ((await askConfirm({ title: 'Update packages', message: `Update ${updates.length} package${updates.length === 1 ? '' : 's'} to the latest ${prerelease ? '' : 'stable '}version in every project that uses them?`, okLabel: 'Update' })) !== 'ok') return;
    for (const id of updates) {
      const targets = installed.filter((p) => p.packages.some((x) => x.id.toLowerCase() === id.toLowerCase() && x.version !== latest[id])).map((p) => p.projectPath);
      await install(id, latest[id], targets);
    }
  };

  if (projects.length === 0) return <div className="panel-empty">Open a solution or project to manage its NuGet packages.</div>;

  return (
    <>
      <div className="console-toolbar">
        <button className={`proc-chip${tab === 'packages' ? ' active' : ''}`} onClick={() => setTab('packages')}>
          <Package size={12} /> Packages
        </button>
        <button className={`proc-chip${tab === 'sources' ? ' active' : ''}`} onClick={() => setTab('sources')}>
          Sources
        </button>
        <div className="topbar-sep" />
        <button className="btn btn-xs btn-ghost" title="dotnet restore" onClick={() => void dotnetBuild('restore')}>
          <Download size={12} /> Restore
        </button>
        <button className="icon-btn sm" title="Refresh" onClick={() => void loadInstalled()}>
          <RefreshCw size={13} />
        </button>
      </div>
      {tab === 'sources' ? (
        <SourcesTab sources={sources} onChanged={() => void api.get<Source[]>('/nuget/sources').then(setSources)} />
      ) : (
        <div className="split-pane">
          <div className="pane-left" style={{ width: '40%' }}>
            <div className="search-form" style={{ paddingTop: 8 }}>
              <div className="search-row">
                <Search size={14} className="muted" />
                <input className="input sm" placeholder={view === 'browse' ? 'Search packages' : 'Filter'} value={query} onChange={(e) => setQuery(e.target.value)} />
                {busy && <LoaderCircle size={14} className="spin muted" />}
              </div>
              <div className="search-row" style={{ flexWrap: 'wrap' }}>
                {(['browse', 'installed', 'updates'] as View[]).map((v) => (
                  <button key={v} className={`proc-chip${view === v ? ' active' : ''}`} onClick={() => setView(v)}>
                    {v === 'browse' ? 'Browse' : v === 'installed' ? `Installed (${installedIds.length})` : `Updates (${updates.length})`}
                  </button>
                ))}
                <label className="check" style={{ fontSize: 'var(--text-xs)', marginLeft: 4 }}>
                  <input type="checkbox" checked={prerelease} onChange={(e) => setPrerelease(e.target.checked)} /> Prerelease
                </label>
                {view === 'browse' && (
                  <select className="input sm" style={{ width: 'auto', marginLeft: 'auto' }} value={source} onChange={(e) => setSource(e.target.value)} title="Package source">
                    <option value="">All sources</option>
                    {sources.filter((s) => s.http && s.enabled).map((s) => (
                      <option key={s.url} value={s.url}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                )}
                {view === 'updates' && updates.length > 0 && (
                  <button className="btn btn-xs btn-primary" style={{ marginLeft: 'auto' }} onClick={() => void updateAll()}>
                    <ArrowUp size={12} /> Update all
                  </button>
                )}
              </div>
            </div>
            <div className="result-list">
              {rows.map((p) => {
                const inst = versionsOf(p.id);
                const hasUpdate = latest[p.id] && inst.some((v) => v !== '?' && cmp(latest[p.id], v) > 0);
                return (
                  <div key={p.id} className={`pkg${selected?.toLowerCase() === p.id.toLowerCase() ? ' selected' : ''}`} onClick={() => setSelected(p.id)}>
                    <div className="pkg-icon">{p.iconUrl ? <img src={p.iconUrl} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')} /> : <Package size={16} />}</div>
                    <div className="pkg-body">
                      <div className="pkg-name">
                        <span>{p.id}</span>
                        {p.verified && <BadgeCheck size={13} style={{ color: 'var(--accent)' }} />}
                        <span className="pkg-ver">{p.version}</span>
                        {inst.length > 0 && (
                          <span className={`ref-badge${hasUpdate ? ' tag' : ''}`} title={hasUpdate ? `Update to ${latest[p.id]}` : 'Installed'}>
                            {hasUpdate ? `↑ ${[...new Set(inst)].join(', ')}` : [...new Set(inst)].join(', ')}
                          </span>
                        )}
                        <span className="pkg-ver" style={{ marginLeft: 'auto' }}>
                          {fmt(p.totalDownloads)}
                        </span>
                      </div>
                      {p.description && <div className="pkg-desc">{p.description}</div>}
                    </div>
                  </div>
                );
              })}
              {!busy && rows.length === 0 && <div className="panel-empty">{view === 'updates' ? 'All packages are up to date.' : view === 'installed' ? 'No packages installed.' : 'No packages found.'}</div>}
            </div>
          </div>
          <div className="pane-right">
            {selected ? (
              <PackageDetails
                id={selected}
                row={rows.find((r) => r.id.toLowerCase() === selected.toLowerCase())}
                prerelease={prerelease}
                installed={installed}
                latest={latest[selected]}
                working={working === selected}
                onInstall={install}
                onRemove={remove}
              />
            ) : (
              <div className="panel-empty">Select a package to see its details and the projects that use it.</div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function PackageDetails({
  id,
  row,
  prerelease,
  installed,
  latest,
  working,
  onInstall,
  onRemove,
}: {
  id: string;
  row?: PackageRow;
  prerelease: boolean;
  installed: ProjectPackages[];
  latest?: string;
  working: boolean;
  onInstall: (id: string, version: string, targets: string[]) => Promise<void>;
  onRemove: (id: string, targets: string[]) => Promise<void>;
}) {
  const [versions, setVersions] = useState<string[]>(row?.versions ?? []);
  const [version, setVersion] = useState<string>(row?.version ?? latest ?? '');
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetails(null);
    setError(null);
    let cancelled = false;
    void api.get<string[]>('/nuget/versions', { id, source: row?.source }).then(
      (v) => {
        if (cancelled) return;
        const list = prerelease ? v : v.filter((x) => !x.includes('-'));
        setVersions(list.length ? list : v);
        setVersion((cur) => (cur && v.includes(cur) ? cur : (list[0] ?? v[0] ?? cur)));
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [id, prerelease]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    api.get<Details>('/nuget/details', { id, version, source: row?.source }).then(
      (d) => !cancelled && setDetails(d),
      (e) => !cancelled && setError(errorText(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [id, version]); // eslint-disable-line react-hooks/exhaustive-deps

  const usage = installed.map((p) => ({ ...p, ref: p.packages.find((x) => x.id.toLowerCase() === id.toLowerCase()) }));
  const without = usage.filter((u) => !u.ref).map((u) => u.projectPath);
  const outdated = usage.filter((u) => u.ref && u.ref.version !== version).map((u) => u.projectPath);

  return (
    <div className="details" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div className="pkg-icon" style={{ width: 40, height: 40 }}>
          {row?.iconUrl ? <img src={row.iconUrl} alt="" /> : <Package size={20} />}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 'var(--text-lg)' }}>{details?.title || id}</div>
          <div className="muted">{details?.authors ?? row?.authors}</div>
        </div>
        <select className="input sm" style={{ width: 150 }} value={version} onChange={(e) => setVersion(e.target.value)} aria-label="Version">
          {(versions.length ? versions : [version]).map((v) => (
            <option key={v} value={v}>
              {v}
              {v === latest ? ' (latest)' : ''}
            </option>
          ))}
        </select>
      </div>

      {details?.deprecation && (
        <div className="test-result" style={{ display: 'flex', gap: 6, color: 'var(--warning)' }}>
          <AlertTriangle size={14} /> Deprecated: {details.deprecation}
        </div>
      )}
      {details && details.vulnerabilities.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--danger-text)' }}>
          {details.vulnerabilities.map((v) => (
            <span key={v} style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              <ShieldAlert size={14} /> {v}
            </span>
          ))}
        </div>
      )}

      {/* projects: Rider's "+ / ↑ / −" per project */}
      <div>
        <div className="section-label" style={{ padding: '0 0 4px', display: 'flex', alignItems: 'center' }}>
          <span style={{ flex: 1 }}>Projects</span>
          {working && <LoaderCircle size={13} className="spin" />}
          {without.length > 0 && (
            <button className="btn btn-xs btn-primary" disabled={working || !version} onClick={() => void onInstall(id, version, without)}>
              <Plus size={12} /> Install to all
            </button>
          )}
          {outdated.length > 0 && (
            <button className="btn btn-xs" style={{ marginLeft: 6 }} disabled={working || !version} onClick={() => void onInstall(id, version, outdated)}>
              <ArrowUp size={12} /> Set {version} everywhere
            </button>
          )}
        </div>
        {usage.map((u) => (
          <div key={u.projectPath} className="result-item" style={{ paddingLeft: 4 }}>
            <Package size={13} className="ic-proj" />
            <span className="msg">{u.project}</span>
            <span className="loc">{u.ref ? `${u.ref.version ?? '?'}${u.ref.central ? ' (central)' : ''}` : 'not installed'}</span>
            <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 2 }}>
              {!u.ref && (
                <button className="icon-btn sm" title={`Install ${version}`} disabled={working || !version} onClick={() => void onInstall(id, version, [u.projectPath])}>
                  <Plus size={13} />
                </button>
              )}
              {u.ref && u.ref.version !== version && (
                <button className="icon-btn sm" title={`${u.ref.version && version && cmp(version, u.ref.version) > 0 ? 'Upgrade' : 'Change'} to ${version}`} disabled={working || !version} onClick={() => void onInstall(id, version, [u.projectPath])}>
                  <ArrowUp size={13} />
                </button>
              )}
              {u.ref && (
                <button className="icon-btn sm" title="Remove" disabled={working} onClick={() => void onRemove(id, [u.projectPath])}>
                  <Minus size={13} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>

      {error ? (
        <div className="muted">{error}</div>
      ) : !details ? (
        <div className="muted">
          <LoaderCircle size={13} className="spin" /> Loading details…
        </div>
      ) : (
        <>
          {details.description && <div style={{ whiteSpace: 'pre-wrap' }}>{details.description}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: '4px 10px' }}>
            <span className="muted">Version</span>
            <span>
              {details.version}
              {!details.listed && ' (unlisted)'}
            </span>
            {details.published && (
              <>
                <span className="muted">Published</span>
                <span>{new Date(details.published).toLocaleDateString()}</span>
              </>
            )}
            {row?.totalDownloads !== undefined && (
              <>
                <span className="muted">Downloads</span>
                <span>{row.totalDownloads.toLocaleString()}</span>
              </>
            )}
            {(details.licenseExpression || details.licenseUrl) && (
              <>
                <span className="muted">License</span>
                <span>
                  {details.licenseExpression ? (
                    details.licenseExpression
                  ) : (
                    <a className="link-btn" style={{ padding: 0 }} onClick={() => platform.openExternal(details.licenseUrl!)}>
                      View license <ExternalLink size={11} />
                    </a>
                  )}
                </span>
              </>
            )}
            {details.projectUrl && (
              <>
                <span className="muted">Project</span>
                <a className="link-btn" style={{ padding: 0, fontWeight: 400 }} onClick={() => platform.openExternal(details.projectUrl!)}>
                  {details.projectUrl} <ExternalLink size={11} />
                </a>
              </>
            )}
            <span className="muted">NuGet</span>
            <a className="link-btn" style={{ padding: 0, fontWeight: 400 }} onClick={() => platform.openExternal(`https://www.nuget.org/packages/${id}/${details.version}`)}>
              nuget.org/packages/{id} <ExternalLink size={11} />
            </a>
            {details.tags && (
              <>
                <span className="muted">Tags</span>
                <span className="muted">{details.tags}</span>
              </>
            )}
          </div>
          <div>
            <div className="section-label" style={{ padding: '4px 0' }}>Dependencies</div>
            {details.dependencyGroups.length === 0 && <div className="muted">No dependencies</div>}
            {details.dependencyGroups.map((g) => (
              <div key={g.targetFramework} style={{ marginBottom: 6 }}>
                <div style={{ fontWeight: 600 }}>{g.targetFramework}</div>
                {g.dependencies.length === 0 ? (
                  <div className="muted" style={{ paddingLeft: 12 }}>No dependencies</div>
                ) : (
                  g.dependencies.map((d) => (
                    <div key={d.id} style={{ paddingLeft: 12 }}>
                      {d.id} <span className="muted">{d.range}</span>
                    </div>
                  ))
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function SourcesTab({ sources, onChanged }: { sources: Source[]; onChanged: () => void }) {
  const toggle = async (s: Source) => {
    const r = await runAndWait({ kind: 'nuget', title: `${s.enabled ? 'Disable' : 'Enable'} ${s.name}`, file: 'dotnet', args: ['nuget', s.enabled ? 'disable' : 'enable', 'source', s.name], cwd: useWorkspace.getState().ws.root });
    if (r?.exitCode === 0) onChanged();
  };
  return (
    <div className="result-list" style={{ padding: 8 }}>
      <div className="muted" style={{ fontSize: 'var(--text-xs)', padding: '0 4px 8px' }}>
        Package sources from the NuGet.Config files this workspace uses (dotnet nuget list source). Search covers enabled v3 feeds.
      </div>
      {sources.map((s) => (
        <div key={s.url} className="pkg" style={{ cursor: 'default' }}>
          <div className="pkg-body">
            <div className="pkg-name">
              <span>{s.name}</span>
              {!s.http && <span className="ref-badge remote">local</span>}
              {!s.enabled && <span className="ref-badge tag">disabled</span>}
            </div>
            <div className="pkg-desc">{s.url}</div>
          </div>
          <button className="btn btn-xs" onClick={() => void toggle(s)}>
            {s.enabled ? 'Disable' : 'Enable'}
          </button>
        </div>
      ))}
    </div>
  );
}
