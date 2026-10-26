import { ArrowRight, FolderOpen, Layers, Plus, X } from 'lucide-react';
import { openFolder, openSolutionFile, openWorkspace } from '../app/actions';
import { keyLabel } from '../app/commands';
import { basename, dirname } from '../lib/paths';
import { useUi } from '../store/ui';
import { useWorkspace } from '../store/workspace';
import { FileIcon, KodMark } from './common/icons';

export function Welcome() {
  const recents = useWorkspace((s) => s.recents);
  const wsStatus = useUi((s) => s.wsStatus);
  return (
    <div className="welcome">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <KodMark size={40} />
          <div>
            <div className="welcome-brand-name">Kod</div>
            <div className="welcome-brand-tagline">A focused C# and .NET IDE</div>
          </div>
        </div>
        <div>
          <h1>Write, run and ship .NET code.</h1>
          <p className="welcome-lead">Roslyn IntelliSense, quick fixes and refactorings, build and run with the dotnet CLI, NuGet and a terminal, in one keyboard-first window.</p>
        </div>
        <section>
          <h2>Start</h2>
          <div className="action-cards">
            <button className="action-card" onClick={() => useUi.getState().set({ newProjectOpen: true })} disabled={wsStatus !== 'open'}>
              <span className="action-card-icon">
                <Plus size={20} />
              </span>
              <span className="action-card-name">New project</span>
              <span className="action-card-blurb">Console, Web API, Blazor, worker, class library or tests, with a solution.</span>
            </button>
            <button className="action-card" onClick={() => void openFolder()} disabled={wsStatus !== 'open'}>
              <span className="action-card-icon">
                <FolderOpen size={20} />
              </span>
              <span className="action-card-name">Open folder</span>
              <span className="action-card-blurb">A repository or any folder; Kod finds the solution and projects in it.</span>
            </button>
            <button className="action-card" onClick={() => void openSolutionFile()} disabled={wsStatus !== 'open'}>
              <span className="action-card-icon">
                <Layers size={20} />
              </span>
              <span className="action-card-name">Open solution</span>
              <span className="action-card-blurb">A .sln, .slnx or .csproj file.</span>
            </button>
          </div>
        </section>
        {recents.length > 0 && (
          <section>
            <h2>Recent</h2>
            <div className="recent-list">
              {recents.map((r) => (
                <div key={r.path} className="recent-item" role="button" tabIndex={0} onClick={() => void openWorkspace(r.path)} onKeyDown={(e) => e.key === 'Enter' && void openWorkspace(r.path)} title={r.path}>
                  <FileIcon path={r.path} isDir={!/\.(slnx?|csproj)$/i.test(r.path)} size={18} />
                  <span className="recent-text">
                    <span className="recent-name">{basename(r.path)}</span>
                    <span className="recent-path">{dirname(r.path)}</span>
                  </span>
                  <button
                    className="icon-btn sm"
                    title="Remove from list"
                    onClick={(e) => {
                      e.stopPropagation();
                      useWorkspace.getState().removeRecent(r.path);
                    }}
                  >
                    <X size={14} />
                  </button>
                  <ArrowRight size={14} className="muted" />
                </div>
              ))}
            </div>
          </section>
        )}
        <div className="welcome-keys">
          <span>
            Search everywhere <span className="kbd-group"><kbd>Shift</kbd><kbd>Shift</kbd></span>
          </span>
          <span>
            Find action <span className="kbd-group"><kbd>{keyLabel('Ctrl+Shift+A')}</kbd></span>
          </span>
          <span>
            Open folder <span className="kbd-group"><kbd>{keyLabel('Ctrl+K')}</kbd><kbd>{keyLabel('Ctrl+O')}</kbd></span>
          </span>
          <span>
            Settings <span className="kbd-group"><kbd>{keyLabel('Ctrl+Alt+S')}</kbd></span>
          </span>
        </div>
      </div>
    </div>
  );
}
