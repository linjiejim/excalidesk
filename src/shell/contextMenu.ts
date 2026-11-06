// 原生右键菜单（NSMenu），浏览器预览里不弹
import { inTauri } from "./ipc";

export type MenuSpec = { text: string; action: () => void; enabled?: boolean } | "-";

export async function popup(items: MenuSpec[]) {
  if (!inTauri) return;
  const { Menu, MenuItem, PredefinedMenuItem } = await import("@tauri-apps/api/menu");
  const built = await Promise.all(
    items.map((i) =>
      i === "-"
        ? PredefinedMenuItem.new({ item: "Separator" })
        : MenuItem.new({ text: i.text, enabled: i.enabled ?? true, action: () => i.action() }),
    ),
  );
  const menu = await Menu.new({ items: built });
  await menu.popup();
}
