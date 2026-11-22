// 原生模块的 JS 门面：文件夹访问、离线渲染（矢量 PDF + 缩略图）、PDFKit 画布。
import { requireNativeModule, requireNativeView } from 'expo';
import { forwardRef, type ComponentType, type Ref } from 'react';
import type { ColorValue, NativeSyntheticEvent, ViewProps } from 'react-native';

export type Location = {
  id: string;
  name: string;
  isFile: boolean;
  isCloud: boolean;
  available: boolean;
  addedAt: number;
};

export type DrawingFile = {
  /** `${locationId}:${path}` */
  id: string;
  locationId: string;
  /** Relative to the location; empty for a single file opened from the Files app */
  path: string;
  /** File name without .excalidraw */
  name: string;
  size: number;
  /** ms since epoch */
  modified: number;
  isCloud: boolean;
  downloaded: boolean;
};

export type Folder = { name: string; path: string; count: number; modified: number };

export type SlideInfo = { id: string; name: string; notes: string };

export type Rendered = {
  elementCount: number;
  imageCount: number;
  background: string;
  darkBackground: string;
  slides: SlideInfo[];
  text: string;
  modified: number;
  size: number;
  /** file:// URLs */
  pdf?: string;
  slidesPdf?: string;
  thumbnail?: string;
};

export type RenderOptions = {
  dark: boolean;
  want?: 'meta' | 'canvas' | 'slides';
  priority?: 'high' | 'low';
};

type NativeModuleShape = {
  getValue(key: string): string | null;
  setValue(key: string, value: string | null): void;
  listLocations(): Location[];
  pickFolder(): Promise<Location | null>;
  removeLocation(id: string): void;
  listFolder(locationId: string, path: string): Promise<{ folders: Folder[]; files: DrawingFile[] }>;
  scanLocation(locationId: string): Promise<DrawingFile[]>;
  openExternal(uri: string): Promise<DrawingFile>;
  render(locationId: string, path: string, options: RenderOptions): Promise<Rendered>;
  cached(locationId: string, path: string, modified: number, size: number, dark: boolean): Rendered | null;
  clearCache(): void;
  share(locationId: string, path: string, kind: 'original' | 'pdf', pdfUri: string | null, title: string): Promise<boolean>;
};

export const Native = requireNativeModule<NativeModuleShape>('ExcalideskNative');

// ── Canvas view ─────────────────────────────────────────

export type ZoomEvent = { relative: number; scale: number; atFit: boolean };
export type PageEvent = { index: number; count: number };

export type DrawingViewProps = ViewProps & {
  source?: string;
  paged?: boolean;
  canvasColor?: ColorValue;
  initialPage?: number;
  onSingleTap?: () => void;
  onZoomChange?: (e: NativeSyntheticEvent<ZoomEvent>) => void;
  onPageChange?: (e: NativeSyntheticEvent<PageEvent>) => void;
  onReady?: (e: NativeSyntheticEvent<{ pageCount: number }>) => void;
};

export type DrawingViewHandle = {
  fit(): Promise<void>;
  goToPage(index: number): Promise<void>;
};

const NativeDrawingView: ComponentType<DrawingViewProps & { ref?: Ref<DrawingViewHandle> }> =
  requireNativeView('ExcalideskNative');

export const DrawingView = forwardRef<DrawingViewHandle, DrawingViewProps>(function DrawingView(props, ref) {
  return <NativeDrawingView {...props} ref={ref} />;
});
