// Clipboard history (Rider's Paste from History): what was copied or cut in Kod, newest first, kept across restarts.
import { create } from 'zustand';
import { loadRaw, save } from '../lib/storage';

export interface ClipEntry {
  text: string;
  at: number;
}

const MAX_ITEMS = 40;
/** Longer copies are kept whole for this session but not written to storage. */
const MAX_SAVED = 100_000;

interface ClipboardState {
  items: ClipEntry[];
  /** The Paste from History dialog. */
  open: boolean;
  add(text: string): void;
  remove(at: number): void;
  clear(): void;
}

const persist = (items: ClipEntry[]) => save('clipboardHistory', items.filter((i) => i.text.length <= MAX_SAVED));

export const useClipboard = create<ClipboardState>((set, get) => ({
  items: loadRaw<ClipEntry[]>('clipboardHistory', []),
  open: false,
  add: (text) => {
    if (!text || !text.trim()) return;
    // the same text again moves to the top
    const items = [{ text, at: Date.now() }, ...get().items.filter((i) => i.text !== text)].slice(0, MAX_ITEMS);
    set({ items });
    persist(items);
  },
  remove: (at) => {
    const items = get().items.filter((i) => i.at !== at);
    set({ items });
    persist(items);
  },
  clear: () => {
    set({ items: [] });
    persist([]);
  },
}));
