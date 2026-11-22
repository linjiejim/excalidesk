import { isZh, t } from './i18n';

const lang = isZh ? 'zh-CN' : undefined;

/** 今天 14:20 / 昨天 / 11月21日 / 2025年3月2日 */
export function formatDate(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86400000);
  if (diff === 0) return `${t.today} ${d.toLocaleTimeString(lang, { hour: '2-digit', minute: '2-digit' })}`;
  if (diff === 1) return t.yesterday;
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(lang, { month: 'short', day: 'numeric' });
  return d.toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** A snippet of `text` around the first match of `q`, for search results. */
export function snippet(text: string, q: string, radius = 28): string | null {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const start = Math.max(0, i - radius);
  const end = Math.min(text.length, i + q.length + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}
