// Auto Save the way Rider does it (Settings › General › Auto save, on by default): files are saved when Kod loses
// focus, when you switch or close a tab, before build / run / test / commit, after a quiet moment without typing or
// clicking, and before Kod quits. Local History keeps every saved version, so nothing is lost by saving often.
import { isDirty, allEntries } from '../editor/models';
import { platform } from '../platform';
import { useEditors } from '../store/editors';
import { useSettings } from '../store/settings';

const rider = () => useSettings.getState().settings.autoSave === 'rider';
const anyDirty = () => allEntries().some((e) => !e.ephemeral && !e.readOnly && isDirty(e));

let saving: Promise<boolean> | null = null;

/** Saves every modified file (one run at a time). */
export function autoSaveAll(): Promise<boolean> {
  if (!rider() || !anyDirty()) return Promise.resolve(true);
  saving ??= useEditors
    .getState()
    .saveAll({ auto: true })
    .finally(() => (saving = null));
  return saving;
}

let idle: ReturnType<typeof setTimeout> | undefined;

/** Any typing or clicking restarts the quiet-moment timer. */
function activity(): void {
  clearTimeout(idle);
  if (!rider()) return;
  idle = setTimeout(() => {
    if (anyDirty()) void autoSaveAll();
  }, useSettings.getState().settings.autoSaveIdleSeconds * 1000);
}

export function installAutoSave(): void {
  window.addEventListener('keydown', activity, true);
  window.addEventListener('mousedown', activity, true);
  // switching to another application (Rider's "save files on frame deactivation")
  window.addEventListener('blur', () => void autoSaveAll());
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void autoSaveAll());

  // switching tabs saves the one you leave
  useEditors.subscribe((s, p) => {
    if (s.active === p.active || !p.active || !rider()) return;
    const left = allEntries().find((e) => e.path === p.active);
    if (left && !left.readOnly && !left.ephemeral && isDirty(left)) void useEditors.getState().save(left.path, { auto: true });
  });

  // quitting: the desktop shell waits for the save before it closes the window
  platform.onBeforeClose?.(async () => {
    if (rider()) await autoSaveAll().catch(() => false);
  });
}
