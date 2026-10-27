import { Copy, FolderOpen, Layers, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { samePath } from '../lib/paths';
import { platform } from '../platform';
import { allConfigs, autoId, launchProfiles, useRunConfigs, type LaunchProfile, type RunConfig } from '../store/runConfigs';
import { useWorkspace } from '../store/workspace';
import { Dialog } from './common/Dialog';
import { showMenuBelow } from './common/Menu';
import { FileIcon } from './common/icons';
import './run.css';

/** "KEY=value" lines ⇄ a variables map. */
const envText = (env?: Record<string, string>) => Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return Object.keys(env).length ? env : undefined;
}

/** A generated configuration the user left as it was is not saved (it follows the project). */
const untouched = (c: RunConfig) =>
  c.id.startsWith('auto:') && c.type === 'project' && samePath(c.id.slice(5), c.project) && !c.args && !c.env && !c.cwd && !c.hotReload && c.profile === undefined && c.name === useWorkspace.getState().ws.projects.find((p) => samePath(p.path, c.project))?.name;

/** Run › Edit Configurations: the list on the left, the selected one's launch settings on the right. */
export function RunConfigsDialog() {
  const projects = useWorkspace((s) => s.ws.projects).filter((p) => p.runnable);
  const [drafts, setDrafts] = useState<RunConfig[]>(() => allConfigs().map((c) => ({ ...c })));
  const [sel, setSel] = useState<string | null>(() => useRunConfigs.getState().activeId ?? drafts[0]?.id ?? null);
  const cur = drafts.find((c) => c.id === sel) ?? drafts[0];
  const close = () => useRunConfigs.setState({ editing: false });
  const up = (p: Partial<RunConfig>) => cur && setDrafts((ds) => ds.map((c) => (c.id === cur.id ? { ...c, ...p } : c)));

  const add = (c: RunConfig) => {
    setDrafts((ds) => [...ds, c]);
    setSel(c.id);
  };
  const uniqueName = (base: string) => {
    let name = base;
    for (let i = 2; drafts.some((c) => c.name === name); i++) name = `${base} (${i})`;
    return name;
  };

  const saveAll = () => {
    const generated = new Set(useWorkspace.getState().ws.projects.filter((p) => p.runnable).map((p) => autoId(p.path)));
    const saved = drafts.filter((c) => !untouched(c)).map((c) => ({ ...c, name: c.name.trim() || 'Unnamed' }));
    const hidden = [...generated].filter((id) => !drafts.some((c) => c.id === id));
    useRunConfigs.getState().replaceAll(saved, hidden);
    if (cur) useRunConfigs.getState().setActive(cur.id);
    close();
  };

  return (
    <Dialog
      title="Run/Debug Configurations"
      onClose={close}
      width={860}
      className="runcfg-dialog"
      footer={
        <>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={saveAll}>
            OK
          </button>
        </>
      }
    >
      <div className="runcfg">
        <div className="runcfg-list">
          <div className="runcfg-tools">
            <button
              className="icon-btn sm"
              title="Add a configuration"
              onClick={(e) =>
                showMenuBelow(e.currentTarget, [
                  ...projects.map((p) => ({ label: `Project: ${p.name}`, icon: <FileIcon path={p.path} size={14} />, run: () => add({ id: `cfg${Date.now()}`, name: uniqueName(p.name), type: 'project', project: p.path }) })),
                  'separator',
                  { label: 'Compound (several at once)', icon: <Layers size={14} />, run: () => add({ id: `cfg${Date.now()}`, name: uniqueName('Compound'), type: 'compound', configs: [] }) },
                ])
              }
            >
              <Plus size={14} />
            </button>
            <button className="icon-btn sm" title="Copy" disabled={!cur} onClick={() => cur && add({ ...cur, id: `cfg${Date.now()}`, name: uniqueName(`${cur.name} copy`) })}>
              <Copy size={13} />
            </button>
            <button
              className="icon-btn sm"
              title="Remove"
              disabled={!cur}
              onClick={() => {
                if (!cur) return;
                const rest = drafts.filter((c) => c.id !== cur.id).map((c) => (c.configs ? { ...c, configs: c.configs.filter((id) => id !== cur.id) } : c));
                setDrafts(rest);
                setSel(rest[0]?.id ?? null);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
          <div className="result-list">
            {drafts.map((c) => (
              <div key={c.id} className={`result-item${c.id === cur?.id ? ' selected' : ''}`} onClick={() => setSel(c.id)}>
                {c.type === 'compound' ? <Layers size={14} className="muted" /> : <FileIcon path={c.project ?? ''} size={14} />}
                <span className="msg">{c.name || 'Unnamed'}</span>
                {c.hotReload && <span className="loc">Hot Reload</span>}
              </div>
            ))}
            {drafts.length === 0 && <div className="panel-empty" style={{ padding: 12 }}>No configurations: add one with +</div>}
          </div>
        </div>
        <div className="runcfg-form">{cur ? cur.type === 'compound' ? <CompoundForm c={cur} all={drafts} up={up} /> : <ProjectForm key={cur.id} c={cur} up={up} /> : null}</div>
      </div>
    </Dialog>
  );
}

function ProjectForm({ c, up }: { c: RunConfig; up: (p: Partial<RunConfig>) => void }) {
  const projects = useWorkspace((s) => s.ws.projects).filter((p) => p.runnable);
  const [profiles, setProfiles] = useState<LaunchProfile[]>([]);
  const [env, setEnv] = useState(envText(c.env));
  useEffect(() => {
    let live = true;
    if (c.project) void launchProfiles(c.project, true).then((p) => live && setProfiles(p));
    return () => {
      live = false;
    };
  }, [c.project]);
  // what the chosen profile brings (the one dotnet run picks when none is chosen)
  const profile = useMemo(() => (c.profile === null ? undefined : c.profile ? profiles.find((p) => p.name === c.profile) : profiles.find((p) => p.commandName === 'Project')), [c.profile, profiles]);

  return (
    <div className="form-grid">
      <label htmlFor="rc-name">Name</label>
      <input id="rc-name" className="input" value={c.name} onChange={(e) => up({ name: e.target.value })} />
      <label htmlFor="rc-project">Project</label>
      <select id="rc-project" className="input" value={c.project ?? ''} onChange={(e) => up({ project: e.target.value, profile: undefined })}>
        {projects.map((p) => (
          <option key={p.path} value={p.path}>
            {p.name}
          </option>
        ))}
      </select>
      <label htmlFor="rc-profile">Launch profile</label>
      <select
        id="rc-profile"
        className="input"
        value={c.profile === null ? '\u0000none' : (c.profile ?? '')}
        onChange={(e) => up({ profile: e.target.value === '' ? undefined : e.target.value === '\u0000none' ? null : e.target.value })}
      >
        <option value="">Default (the first project profile)</option>
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
            {p.commandName !== 'Project' ? ` (${p.commandName})` : ''}
          </option>
        ))}
        <option value={'\u0000none'}>None (ignore launchSettings.json)</option>
      </select>
      {profile && (
        <>
          <span />
          <div className="form-help">
            {[profile.applicationUrl && `URLs: ${profile.applicationUrl}`, Object.keys(profile.env).length > 0 && `Variables: ${Object.keys(profile.env).join(', ')}`, profile.commandLineArgs && `Arguments: ${profile.commandLineArgs}`].filter(Boolean).join(' · ') || 'No URLs, variables or arguments'}
          </div>
        </>
      )}
      <label htmlFor="rc-args">Program arguments</label>
      <input id="rc-args" className="input mono" value={c.args ?? ''} onChange={(e) => up({ args: e.target.value || undefined })} placeholder={profile?.commandLineArgs ?? '--verbose "a value"'} spellCheck={false} />
      <label htmlFor="rc-cwd">Working directory</label>
      <div style={{ display: 'flex', gap: 4 }}>
        <input id="rc-cwd" className="input" value={c.cwd ?? ''} onChange={(e) => up({ cwd: e.target.value || undefined })} placeholder="The project folder" spellCheck={false} />
        <button
          className="btn"
          title="Choose a folder"
          onClick={async () => {
            const f = await platform.pickFolder('Working directory');
            if (f) up({ cwd: f });
          }}
        >
          <FolderOpen size={14} />
        </button>
      </div>
      <label htmlFor="rc-env" style={{ alignSelf: 'start', paddingTop: 4 }}>
        Environment variables
      </label>
      <div>
        <textarea
          id="rc-env"
          className="input mono"
          rows={4}
          value={env}
          onChange={(e) => {
            setEnv(e.target.value);
            up({ env: parseEnv(e.target.value) });
          }}
          placeholder={'ASPNETCORE_ENVIRONMENT=Staging\nMY_SETTING=1'}
          spellCheck={false}
        />
        <div className="form-help">One KEY=value per line, on top of the launch profile's.</div>
      </div>
      <span />
      <label className="check">
        <input type="checkbox" checked={!!c.hotReload} onChange={(e) => up({ hotReload: e.target.checked || undefined })} /> Hot Reload: apply saved changes to the running app (dotnet watch)
      </label>
    </div>
  );
}

function CompoundForm({ c, all, up }: { c: RunConfig; all: RunConfig[]; up: (p: Partial<RunConfig>) => void }) {
  const members = c.configs ?? [];
  return (
    <div className="form-grid">
      <label htmlFor="rc-name">Name</label>
      <input id="rc-name" className="input" value={c.name} onChange={(e) => up({ name: e.target.value })} />
      <label style={{ alignSelf: 'start' }}>Starts</label>
      <div>
        {all
          .filter((x) => x.type === 'project')
          .map((x) => (
            <label key={x.id} className="check" style={{ display: 'flex', marginBottom: 4 }}>
              <input type="checkbox" checked={members.includes(x.id)} onChange={(e) => up({ configs: e.target.checked ? [...members, x.id] : members.filter((id) => id !== x.id) })} /> {x.name}
            </label>
          ))}
        <div className="form-help">Run starts them all. Debug debugs the first one and runs the rest: Kod debugs one program at a time.</div>
      </div>
    </div>
  );
}
