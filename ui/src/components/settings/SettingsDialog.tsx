// Settings (Rowlit's dialog): one fixed-size dialog for every section, a sidebar with search and the sections, and a
// content pane of cards. Typing in the search shows the matching rows of every section at once.
import { Bug, Code, Download, Hammer, Palette, Search, Settings as SettingsIcon, SlidersHorizontal, Sparkles, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { platform } from '../../platform';
import { useUi } from '../../store/ui';
import { useUpdates } from '../../store/updates';
import { Dialog } from '../common/Dialog';
import { useSettingsNav, type SettingsSection } from './nav';
import { SettingsQuery } from './search';
import { AppearanceSection, BuildSection, DebuggerSection, EditorSection, GeneralSection } from './sections';
import { UpdatesCard } from './UpdatesCard';
import { AiSection } from './AiSection';
import './settings.css';

interface SectionDef {
  id: SettingsSection;
  label: string;
  icon: ReactNode;
  description: string;
  render: () => ReactNode;
}

const SECTIONS: SectionDef[] = [
  { id: 'general', label: 'General', icon: <SlidersHorizontal size={16} />, description: 'Startup, files and the essentials.', render: () => <GeneralSection /> },
  { id: 'appearance', label: 'Appearance', icon: <Palette size={16} />, description: 'Color theme, code theme and text.', render: () => <AppearanceSection /> },
  { id: 'editor', label: 'Editor', icon: <Code size={16} />, description: 'Writing and formatting code.', render: () => <EditorSection /> },
  { id: 'build', label: 'Build & run', icon: <Hammer size={16} />, description: 'Building, running and testing projects.', render: () => <BuildSection /> },
  { id: 'debugger', label: 'Debugger', icon: <Bug size={16} />, description: 'Breakpoints, stepping and the debug engine.', render: () => <DebuggerSection /> },
  { id: 'ai', label: 'AI Assistant', icon: <Sparkles size={16} />, description: 'Claude, ChatGPT, GLM and other AI providers.', render: () => <AiSection /> },
  { id: 'updates', label: 'Updates', icon: <Download size={16} />, description: 'Your version of Kod and new releases.', render: () => <UpdatesCard /> },
];

export function SettingsDialog() {
  const open = useUi((s) => s.settingsOpen);
  if (!open) return null;
  return <Inner />;
}

function Inner() {
  const section = useSettingsNav((s) => s.section);
  const setSection = useSettingsNav((s) => s.setSection);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const close = () => useUi.getState().set({ settingsOpen: false });
  const current = SECTIONS.find((x) => x.id === section) ?? SECTIONS[0];
  const updateState = useUpdates((s) => s.status?.state);
  const updatePending = updateState === 'ready' || updateState === 'available';

  // while searching: visible rows per section, read back from the rendered rows
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    if (!q) return;
    const next: Record<string, number> = {};
    resultsRef.current?.querySelectorAll<HTMLElement>('[data-settings-section]').forEach((el) => {
      next[el.dataset.settingsSection!] = el.querySelectorAll('[data-settings-row]:not([hidden])').length;
    });
    setCounts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
  }, [q]);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const go = (id: SettingsSection) => {
    setQuery('');
    setSection(id);
  };
  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo?.({ top: 0 });
  }, [section, q]);

  return (
    <Dialog title="Settings" onClose={close} width={960} className="settings-dialog">
      <div className="settings-shell">
        <aside className="settings-side">
          <div className="settings-side-head">
            <span className="settings-side-icon" aria-hidden="true">
              <SettingsIcon size={16} />
            </span>
            <span className="settings-side-title">Settings</span>
          </div>
          <div className="settings-search">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              className="settings-search-input"
              placeholder="Search settings"
              aria-label="Search settings"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && query) {
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            {query && (
              <button type="button" className="settings-search-clear" aria-label="Clear search" onClick={() => setQuery('')}>
                <X size={12} />
              </button>
            )}
          </div>
          <nav className="settings-nav" role="tablist" aria-orientation="vertical" aria-label="Settings sections">
            {SECTIONS.map((x) => {
              const n = q ? (counts[x.id] ?? 0) : undefined;
              const active = !q && section === x.id;
              return (
                <button key={x.id} type="button" role="tab" aria-selected={active} className={`settings-nav-item${active ? ' active' : ''}${n === 0 ? ' dim' : ''}`} onClick={() => go(x.id)}>
                  <span className="settings-nav-icon" aria-hidden="true">
                    {x.icon}
                  </span>
                  <span className="settings-nav-label">{x.label}</span>
                  {n !== undefined && n > 0 && (
                    <span className="settings-nav-count" aria-hidden="true">
                      {n}
                    </span>
                  )}
                  {n === undefined && x.id === 'updates' && updatePending && <span className="settings-nav-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </nav>
          <div className="settings-side-foot">Kod {platform.appVersion ?? ''}</div>
        </aside>

        <main className="settings-main" role="tabpanel" aria-label={q ? 'Search results' : current.label}>
          <header className="settings-main-head">
            <h2 className="settings-main-title">{q ? 'Search results' : current.label}</h2>
            <p className="settings-main-desc">{q ? (total ? `Settings matching “${query.trim()}”` : `No settings match “${query.trim()}”`) : current.description}</p>
          </header>
          {q ? (
            <div
              className="settings-scroll"
              ref={(el) => {
                scrollRef.current = el;
                resultsRef.current = el;
              }}
            >
              <SettingsQuery.Provider value={q}>
                {SECTIONS.map((x) => (
                  <div key={x.id} className="settings-result-group" data-settings-section={x.id} hidden={counts[x.id] === 0}>
                    <button type="button" className="settings-result-head" onClick={() => go(x.id)}>
                      {x.icon} {x.label}
                    </button>
                    {x.render()}
                  </div>
                ))}
              </SettingsQuery.Provider>
              {!total && (
                <div className="settings-empty">
                  <Search size={28} aria-hidden="true" />
                  <div>Try another word, e.g. “theme”, “font” or “update”.</div>
                </div>
              )}
            </div>
          ) : (
            <div className="settings-scroll" ref={scrollRef}>
              {current.render()}
            </div>
          )}
        </main>
      </div>
    </Dialog>
  );
}
