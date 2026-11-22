// 从「文件」App 点 .excalidraw →「用 Excalidesk 打开」：原地打开（不复制），直接进预览。
import { openExternal } from '@/lib/store';

export async function redirectSystemPath({ path }: { path: string; initial: boolean }) {
  if (path.startsWith('file://')) {
    try {
      const id = await openExternal(path);
      return `/viewer?id=${encodeURIComponent(id)}`;
    } catch {
      return '/';
    }
  }
  return path;
}
