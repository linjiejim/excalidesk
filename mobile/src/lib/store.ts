// 全局状态：已授权的文件夹、扫描到的图、最近打开、偏好。一个小的外部 store + useSyncExternalStore。
import { useSyncExternalStore } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { Native, type DrawingFile, type Location, type SlideInfo } from '@native';

export type CanvasTheme = 'system' | 'light' | 'dark';
export type SortMode = 'modified' | 'name';
export type Recent = { id: string; at: number };

type State = {
  ready: boolean;
  locations: Location[];
  /** Every drawing in each location (recursive scan), by location id */
  files: Record<string, DrawingFile[]>;
  scanning: boolean;
  recents: Recent[];
  canvas: CanvasTheme;
  sort: SortMode;
  /** Notes of the slide being shown, for the notes sheet */
  notes: { slide: SlideInfo; index: number; count: number } | null;
};

let state: State = {
  ready: false,
  locations: [],
  files: {},
  scanning: false,
  recents: [],
  canvas: 'system',
  sort: 'modified',
  notes: null,
};

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const set = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  emit();
};

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export const getState = () => state;

// ── persistence ───────────────────────────────────────

function load<T>(key: string, fallback: T): T {
  try {
    const raw = Native.getValue(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}
const save = (key: string, value: unknown) => Native.setValue(key, JSON.stringify(value));

// ── actions ───────────────────────────────────────────

let refreshing: Promise<void> | null = null;

/** Re-reads the folder list and rescans every folder (on launch, on return to foreground, on pull to refresh). */
export function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const locations = Native.listLocations();
    set({ locations, scanning: true });
    const files: Record<string, DrawingFile[]> = {};
    await Promise.all(
      locations.map(async (loc) => {
        try {
          files[loc.id] = loc.available ? await Native.scanLocation(loc.id) : [];
        } catch {
          files[loc.id] = [];
        }
      }),
    );
    set({ files, scanning: false });
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export function init() {
  if (state.ready) return;
  set({
    ready: true,
    recents: load<Recent[]>('recents', []),
    canvas: load<CanvasTheme>('canvas', 'system'),
    sort: load<SortMode>('sort', 'modified'),
    locations: Native.listLocations(),
  });
  void refresh();
  AppState.addEventListener('change', (s) => {
    if (s === 'active') void refresh();
  });
}

export async function addFolder(): Promise<Location | null> {
  const loc = await Native.pickFolder();
  if (loc) await refresh();
  return loc;
}

export function removeLocation(id: string) {
  Native.removeLocation(id);
  const { [id]: _, ...rest } = state.files;
  const recents = state.recents.filter((r) => !r.id.startsWith(`${id}:`));
  save('recents', recents);
  set({ locations: state.locations.filter((l) => l.id !== id), files: rest, recents });
}

/** A file handed over by the Files app becomes a one-file location; returns its id. */
export async function openExternal(uri: string): Promise<string> {
  const file = await Native.openExternal(uri);
  await refresh();
  return file.id;
}

export function markOpened(id: string) {
  const recents = [{ id, at: Date.now() }, ...state.recents.filter((r) => r.id !== id)].slice(0, 40);
  save('recents', recents);
  set({ recents });
}

export function setCanvas(canvas: CanvasTheme) {
  save('canvas', canvas);
  set({ canvas });
}

export function setSort(sort: SortMode) {
  save('sort', sort);
  set({ sort });
}

export function setNotes(notes: State['notes']) {
  set({ notes });
}

// ── selectors ─────────────────────────────────────────

export function allFiles(s: State = state): DrawingFile[] {
  return Object.values(s.files).flat();
}

export function findFile(id: string, s: State = state): DrawingFile | undefined {
  const sep = id.indexOf(':');
  const loc = id.slice(0, sep);
  return s.files[loc]?.find((f) => f.id === id);
}

export function locationName(id: string, s: State = state): string {
  return s.locations.find((l) => l.id === id)?.name ?? '';
}

export function sortFiles(files: DrawingFile[], sort: SortMode): DrawingFile[] {
  const copy = [...files];
  if (sort === 'name') copy.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  else copy.sort((a, b) => b.modified - a.modified);
  return copy;
}

/** Whether the canvas is drawn dark right now. */
export function useCanvasDark(): boolean {
  const scheme = useColorScheme();
  const canvas = useStore((s) => s.canvas);
  return canvas === 'system' ? scheme === 'dark' : canvas === 'dark';
}
