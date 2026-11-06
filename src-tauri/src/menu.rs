//! 原生菜单。菜单项只发事件给前端（`menu` 事件，payload 是 id），具体动作由前端决定。
//! 不放「撤销 / 重做」：菜单会先吃掉 ⌘Z，Excalidraw 自己的历史就收不到了。

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(app, "Excalidesk", true, &[
        &PredefinedMenuItem::about(app, Some("关于 Excalidesk"), None)?,
        &sep()?,
        &PredefinedMenuItem::services(app, Some("服务"))?,
        &sep()?,
        &PredefinedMenuItem::hide(app, Some("隐藏 Excalidesk"))?,
        &PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?,
        &PredefinedMenuItem::show_all(app, Some("全部显示"))?,
        &sep()?,
        &PredefinedMenuItem::quit(app, Some("退出 Excalidesk"))?,
    ])?;
    let file = Submenu::with_items(app, "文件", true, &[
        &item("new", "新建图", Some("CmdOrCtrl+N"))?,
        &item("open", "打开…", Some("CmdOrCtrl+O"))?,
        &item("open_folder", "添加文件夹…", Some("CmdOrCtrl+Shift+O"))?,
        &sep()?,
        &item("save", "保存", Some("CmdOrCtrl+S"))?,
        &item("export_png", "导出 PNG…", Some("CmdOrCtrl+Shift+E"))?,
        &item("export_svg", "导出 SVG…", None)?,
        &item("history", "历史版本…", Some("CmdOrCtrl+Alt+Y"))?,
        &sep()?,
        &item("reveal", "在 Finder 中显示", Some("CmdOrCtrl+Shift+R"))?,
        &item("close_tab", "关闭标签页", Some("CmdOrCtrl+W"))?,
    ])?;
    let edit = Submenu::with_items(app, "编辑", true, &[
        &PredefinedMenuItem::cut(app, Some("剪切"))?,
        &PredefinedMenuItem::copy(app, Some("拷贝"))?,
        &PredefinedMenuItem::paste(app, Some("粘贴"))?,
        &PredefinedMenuItem::select_all(app, Some("全选"))?,
    ])?;
    let view = Submenu::with_items(app, "显示", true, &[
        &item("toggle_sidebar", "显示 / 隐藏侧边栏", Some("CmdOrCtrl+Backslash"))?,
        &item("focus_mode", "专注模式", Some("CmdOrCtrl+Period"))?,
        &sep()?,
        &item("next_tab", "下一个标签页", Some("CmdOrCtrl+Shift+BracketRight"))?,
        &item("prev_tab", "上一个标签页", Some("CmdOrCtrl+Shift+BracketLeft"))?,
        &sep()?,
        &PredefinedMenuItem::fullscreen(app, Some("进入全屏"))?,
    ])?;
    let window = Submenu::with_items(app, "窗口", true, &[
        &PredefinedMenuItem::minimize(app, Some("最小化"))?,
        &PredefinedMenuItem::maximize(app, Some("缩放"))?,
    ])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}
