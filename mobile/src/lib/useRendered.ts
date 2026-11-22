// 拿一张图的渲染结果：先查磁盘缓存（同步、很快），没有再排队在后台渲染（低优先级，不挡打开中的图）。
import { useEffect, useState } from 'react';

import { Native, type DrawingFile, type Rendered } from '@native';

export function useRendered(file: DrawingFile | undefined, dark: boolean, enabled = true) {
  const key = file ? `${file.id}|${file.modified}|${file.size}|${dark}` : '';
  const [state, setState] = useState<{ key: string; value: Rendered | null; failed: boolean }>(() => ({
    key,
    value: file ? Native.cached(file.locationId, file.path, file.modified, file.size, dark) : null,
    failed: false,
  }));

  // file changed (new version, theme switch): start from the cache again
  let current = state;
  if (state.key !== key) {
    current = {
      key,
      value: file ? Native.cached(file.locationId, file.path, file.modified, file.size, dark) : null,
      failed: false,
    };
    setState(current);
  }

  const needsWork = !!file && enabled && file.downloaded && !current.value?.thumbnail && !current.failed;
  useEffect(() => {
    if (!needsWork || !file) return;
    let alive = true;
    Native.render(file.locationId, file.path, { dark, want: 'canvas', priority: 'low' })
      .then((value) => alive && setState({ key, value, failed: false }))
      .catch((e) => {
        if (__DEV__) console.warn('render failed', file.name, JSON.stringify({ message: e?.message, code: e?.code, info: e?.info, s: String(e) }));
        if (alive) setState({ key, value: null, failed: true });
      });
    return () => {
      alive = false;
    };
  }, [needsWork, key]); // eslint-disable-line react-hooks/exhaustive-deps

  return { rendered: current.value, failed: current.failed };
}
