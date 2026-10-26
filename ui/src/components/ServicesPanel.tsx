import { Box, ChevronDown, ChevronRight, CircleDot, Container as ContainerIcon, Layers, LoaderCircle, Play, RotateCw, ScrollText, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { basename, dirname, relative } from '../lib/paths';
import { compose, composeLogs, containerAction, containerLogs, containerShell, refreshDocker, removeImage, useDocker, type ComposeFile, type Container } from '../store/docker';
import { useWorkspace } from '../store/workspace';
import { showContextMenu, type MenuItem } from './common/Menu';

const stateClass = (s: string) => (s === 'running' ? 'svc-running' : s === 'paused' || s === 'restarting' ? 'svc-paused' : 'svc-stopped');

/** Rider's Services window (Docker): Compose projects and their services, containers and images, with their actions. */
export function ServicesPanel() {
  const { info, containers, images, compose: files, loading } = useDocker();
  const root = useWorkspace((s) => s.ws.root);
  const [open, setOpen] = useState<Record<string, boolean>>({ compose: true, containers: true });

  useEffect(() => {
    void refreshDocker();
    const t = setInterval(() => void refreshDocker(), 10_000);
    return () => clearInterval(t);
  }, []);

  const toggle = (k: string) => setOpen({ ...open, [k]: !open[k] });
  const head = (k: string, icon: ReactNode, label: string, count: number, depth = 0, menu?: MenuItem[], extra?: ReactNode) => (
    <div className="tree-row" style={{ paddingLeft: 6 + depth * 16 }} onClick={() => toggle(k)} onContextMenu={(e) => menu && showContextMenu(e, menu)}>
      <span className="tree-chevron">{open[k] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      {icon}
      <span className="tree-label">{label}</span>
      <span className="tree-hint">{count}</span>
      {extra}
    </div>
  );

  const containerMenu = (c: Container): MenuItem[] => [
    c.state === 'running'
      ? { label: 'Stop', icon: <Square size={14} />, run: () => void containerAction(c, 'stop') }
      : { label: 'Start', icon: <Play size={14} />, run: () => void containerAction(c, 'start') },
    { label: 'Restart', icon: <RotateCw size={14} />, run: () => void containerAction(c, 'restart') },
    'separator',
    { label: 'Show Log', icon: <ScrollText size={14} />, run: () => containerLogs(c) },
    { label: 'Open Terminal', icon: <SquareTerminal size={14} />, disabled: c.state !== 'running', run: () => void containerShell(c) },
    'separator',
    { label: 'Remove', icon: <Trash2 size={14} />, danger: true, run: () => void containerAction(c, 'rm') },
  ];

  const containerRow = (c: Container, depth: number, label = c.name) => (
    <div key={c.id} className="tree-row svc-row" style={{ paddingLeft: 6 + depth * 16 + 18 }} title={`${c.image}\n${c.status}${c.ports ? `\n${c.ports}` : ''}`} onDoubleClick={() => containerLogs(c)} onContextMenu={(e) => showContextMenu(e, containerMenu(c))}>
      <CircleDot size={12} className={stateClass(c.state)} />
      <span className="tree-label">{label}</span>
      <span className="tree-hint">{c.status}</span>
      {c.ports && <span className="tree-hint svc-ports">{c.ports.replace(/0\.0\.0\.0:|\[::\]:/g, '').split(', ').filter((p, i, a) => a.indexOf(p) === i).slice(0, 3).join(', ')}</span>}
      <span className="svc-actions">
        {c.state === 'running' ? (
          <button className="icon-btn sm" title="Stop" onClick={() => void containerAction(c, 'stop')}>
            <Square size={12} />
          </button>
        ) : (
          <button className="icon-btn sm" title="Start" onClick={() => void containerAction(c, 'start')}>
            <Play size={12} />
          </button>
        )}
        <button className="icon-btn sm" title="Show log" onClick={() => containerLogs(c)}>
          <ScrollText size={12} />
        </button>
        {c.state === 'running' && (
          <button className="icon-btn sm" title="Open a terminal in the container" onClick={() => void containerShell(c)}>
            <SquareTerminal size={12} />
          </button>
        )}
      </span>
    </div>
  );

  const composeMenu = (f: ComposeFile, service?: string): MenuItem[] => [
    { label: service ? `Up ${service}` : 'Up (start everything)', icon: <Play size={14} />, run: () => void compose(f, 'up', service) },
    { label: 'Stop', icon: <Square size={14} />, run: () => void compose(f, 'stop', service) },
    { label: 'Restart', icon: <RotateCw size={14} />, run: () => void compose(f, 'restart', service) },
    ...(!service ? ([{ label: 'Down (remove containers)', icon: <Trash2 size={14} />, danger: true, run: () => void compose(f, 'down') }] as MenuItem[]) : []),
    'separator',
    { label: 'Show Log', icon: <ScrollText size={14} />, run: () => composeLogs(f, service) },
    { label: 'Build', run: () => void compose(f, 'build', service) },
    { label: 'Pull', run: () => void compose(f, 'pull', service) },
  ];

  const composed = new Set<string>();
  return (
    <>
      <div className="console-toolbar">
        <ContainerIcon size={14} />
        <b>Docker</b>
        {info && <span className={`muted${info.running ? '' : ' sev-warning'}`}>{info.running ? `engine ${info.version ?? ''} · ${info.serverArch ?? ''}` : (info.error ?? 'not running')}</span>}
        <div className="flex-1" />
        <button className="icon-btn sm" title="Refresh" onClick={() => void refreshDocker()}>
          {loading ? <LoaderCircle size={14} className="spin" /> : <RotateCw size={14} />}
        </button>
      </div>
      <div className="result-list tree">
        {info && !info.installed && <div className="panel-empty">The docker CLI is not installed (or not on PATH). Install Docker Desktop, Podman or Rancher Desktop.</div>}
        {files.length > 0 && (
          <>
            {head('compose', <Layers size={14} className="muted" />, 'Docker Compose', files.length)}
            {open.compose &&
              files.map((f) => {
                const k = `c:${f.path}`;
                const mine = containers.filter((c) => c.composeFile ? c.composeFile.split(',').some((x) => x.toLowerCase() === f.path.toLowerCase()) : c.composeProject === f.project);
                mine.forEach((c) => composed.add(c.id));
                const running = mine.filter((c) => c.state === 'running').length;
                return (
                  <div key={k}>
                    {head(k, <Layers size={14} style={{ color: 'var(--syn-interface)' }} />, relative(root, f.path) || basename(f.path), f.services.length, 1, composeMenu(f), (
                      <span className="svc-actions">
                        <span className="muted" style={{ fontSize: 'var(--text-xs)', marginRight: 4 }}>
                          {running}/{f.services.length} running
                        </span>
                        <button
                          className="icon-btn sm"
                          title="docker compose up"
                          onClick={(e) => {
                            e.stopPropagation();
                            void compose(f, 'up');
                          }}
                        >
                          <Play size={12} />
                        </button>
                        <button
                          className="icon-btn sm"
                          title="docker compose stop"
                          onClick={(e) => {
                            e.stopPropagation();
                            void compose(f, 'stop');
                          }}
                        >
                          <Square size={12} />
                        </button>
                      </span>
                    ))}
                    {open[k] &&
                      f.services.map((svc) => {
                        const c = mine.find((x) => x.composeService === svc);
                        return c ? (
                          containerRow(c, 2, `${svc}  (${c.name})`)
                        ) : (
                          <div key={svc} className="tree-row svc-row" style={{ paddingLeft: 6 + 2 * 16 + 18 }} onContextMenu={(e) => showContextMenu(e, composeMenu(f, svc))} title={`${svc}: not created yet`}>
                            <CircleDot size={12} className="svc-none" />
                            <span className="tree-label">{svc}</span>
                            <span className="tree-hint">not started</span>
                            <span className="svc-actions">
                              <button className="icon-btn sm" title={`docker compose up ${svc}`} onClick={() => void compose(f, 'up', svc)}>
                                <Play size={12} />
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    {open[k] && <div className="tree-row muted" style={{ paddingLeft: 6 + 2 * 16 + 18, fontSize: 'var(--text-xs)' }}>{dirname(relative(root, f.path)) || '.'}</div>}
                  </div>
                );
              })}
          </>
        )}
        {info?.running && (
          <>
            {head('containers', <Box size={14} className="muted" />, 'Containers', containers.filter((c) => !composed.has(c.id)).length)}
            {open.containers && containers.filter((c) => !composed.has(c.id)).map((c) => containerRow(c, 1))}
            {head('images', <Layers size={14} className="muted" />, 'Images', images.length)}
            {open.images &&
              images.map((img) => (
                <div
                  key={img.id + img.tag}
                  className="tree-row svc-row"
                  style={{ paddingLeft: 6 + 16 + 18 }}
                  onContextMenu={(e) => showContextMenu(e, [{ label: 'Remove Image', icon: <Trash2 size={14} />, danger: true, run: () => void removeImage(img) }])}
                >
                  <Layers size={12} className="muted" />
                  <span className="tree-label">
                    {img.repository}:{img.tag}
                  </span>
                  <span className="tree-hint">
                    {img.size} · {img.created}
                  </span>
                </div>
              ))}
          </>
        )}
        {info && !info.running && info.installed && files.length === 0 && <div className="panel-empty">{info.error ?? 'The Docker engine is not running.'}</div>}
      </div>
    </>
  );
}
