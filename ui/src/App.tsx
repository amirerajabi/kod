import { RefreshCw } from 'lucide-react';
import { useEffect } from 'react';
import { boot } from './app/boot';
import { installKeys } from './app/commands';
import { AiPanel } from './components/AiPanel';
import { BottomPanel } from './components/BottomPanel';
import { CommandPalette } from './components/CommandPalette';
import { MenuHost } from './components/common/Menu';
import { ConfirmDialog, PromptDialog, Toasts } from './components/common/Overlays';
import { Dock } from './components/Dock';
import { EditorArea } from './components/EditorArea';
import { NewProjectDialog } from './components/NewProjectDialog';
import { RefactorDialogs } from './components/RefactorDialogs';
import { GitDialogs } from './components/GitDialogs';
import { RemotesDialog } from './components/RemotesDialog';
import { SettingsDialog } from './components/settings/SettingsDialog';
import { ShortcutSheet } from './components/ShortcutSheet';
import { VisualizerDialog } from './components/VisualizerDialog';
import { MemoryDialog } from './components/MemoryPanel';
import { StatusBar } from './components/StatusBar';
import { TopBar } from './components/TopBar';
import { Welcome } from './components/Welcome';
import { useUi } from './store/ui';
import { useWorkspace } from './store/workspace';

export default function App() {
  const root = useWorkspace((s) => s.ws.root);

  useEffect(() => {
    void boot();
    return installKeys();
  }, []);

  return (
    <div className="app">
      <TopBar />
      <EngineBanner />
      <div className="main">
        {root ? (
          <>
            <Dock />
            <div className="center">
              <EditorArea />
              <BottomPanel />
            </div>
            <AiPanel />
          </>
        ) : (
          <div className="center">
            <Welcome />
          </div>
        )}
        {!root && <AiPanel />}
      </div>
      <StatusBar />
      <MenuHost />
      <CommandPalette />
      <SettingsDialog />
      <ShortcutSheet />
      <VisualizerDialog />
      <MemoryDialog />
      <NewProjectDialog />
      <RemotesDialog />
      <RefactorDialogs />
      <GitDialogs />
      <PromptDialog />
      <ConfirmDialog />
      <Toasts />
    </div>
  );
}

function EngineBanner() {
  const err = useUi((s) => s.engineError);
  if (!err) return null;
  return (
    <div className="engine-banner" role="alert">
      <span>{err}</span>
      <span className="muted">Retrying…</span>
      <RefreshCw size={12} className="spin" />
    </div>
  );
}
