//! 原生菜单（中英两套文案，切换语言时由前端调 set_menu_lang 重建）。
//! 菜单项只发事件给前端（`menu` 事件，payload 是 id），具体动作由前端决定。
//! 不放「撤销 / 重做」：菜单会先吃掉 ⌘Z，Excalidraw 自己的历史就收不到了。

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Runtime,
};

pub fn build<R: Runtime>(app: &AppHandle<R>, lang: &str) -> tauri::Result<Menu<R>> {
    let zh = lang.starts_with("zh");
    let l = |z: &'static str, e: &'static str| if zh { z } else { e };
    let item = |id: &str, text: &str, accel: Option<&str>| MenuItem::with_id(app, id, text, true, accel);
    let sep = || PredefinedMenuItem::separator(app);

    let app_menu = Submenu::with_items(app, "Excalidesk", true, &[
        &PredefinedMenuItem::about(app, Some(l("关于 Excalidesk", "About Excalidesk")), None)?,
        &sep()?,
        &item("settings", l("设置…", "Settings…"), Some("CmdOrCtrl+Comma"))?,
        &sep()?,
        &PredefinedMenuItem::services(app, Some(l("服务", "Services")))?,
        &sep()?,
        &PredefinedMenuItem::hide(app, Some(l("隐藏 Excalidesk", "Hide Excalidesk")))?,
        &PredefinedMenuItem::hide_others(app, Some(l("隐藏其他", "Hide Others")))?,
        &PredefinedMenuItem::show_all(app, Some(l("全部显示", "Show All")))?,
        &sep()?,
        &PredefinedMenuItem::quit(app, Some(l("退出 Excalidesk", "Quit Excalidesk")))?,
    ])?;
    let file = Submenu::with_items(app, l("文件", "File"), true, &[
        &item("new", l("新建图", "New Drawing"), Some("CmdOrCtrl+N"))?,
        &item("open", l("打开…", "Open…"), Some("CmdOrCtrl+O"))?,
        &item("open_folder", l("添加文件夹…", "Add Folder…"), Some("CmdOrCtrl+Shift+O"))?,
        &sep()?,
        &item("save", l("保存", "Save"), Some("CmdOrCtrl+S"))?,
        &item("export_png", l("导出 PNG…", "Export PNG…"), Some("CmdOrCtrl+Shift+E"))?,
        &item("export_svg", l("导出 SVG…", "Export SVG…"), None)?,
        &item("history", l("历史版本…", "Version History…"), Some("CmdOrCtrl+Alt+Y"))?,
        &sep()?,
        &item("reveal", l("在 Finder 中显示", "Show in Finder"), Some("CmdOrCtrl+Shift+R"))?,
        &item("close_tab", l("关闭标签页", "Close Tab"), Some("CmdOrCtrl+W"))?,
    ])?;
    let edit = Submenu::with_items(app, l("编辑", "Edit"), true, &[
        &PredefinedMenuItem::cut(app, Some(l("剪切", "Cut")))?,
        &PredefinedMenuItem::copy(app, Some(l("拷贝", "Copy")))?,
        &PredefinedMenuItem::paste(app, Some(l("粘贴", "Paste")))?,
        &PredefinedMenuItem::select_all(app, Some(l("全选", "Select All")))?,
    ])?;
    let view = Submenu::with_items(app, l("显示", "View"), true, &[
        &item("toggle_sidebar", l("显示 / 隐藏侧边栏", "Toggle Sidebar"), Some("CmdOrCtrl+Backslash"))?,
        &item("focus_mode", l("专注模式", "Focus Mode"), Some("CmdOrCtrl+Period"))?,
        &sep()?,
        &item("next_tab", l("下一个标签页", "Next Tab"), Some("CmdOrCtrl+Shift+BracketRight"))?,
        &item("prev_tab", l("上一个标签页", "Previous Tab"), Some("CmdOrCtrl+Shift+BracketLeft"))?,
        &sep()?,
        &PredefinedMenuItem::fullscreen(app, Some(l("进入全屏", "Enter Full Screen")))?,
    ])?;
    let window = Submenu::with_items(app, l("窗口", "Window"), true, &[
        &PredefinedMenuItem::minimize(app, Some(l("最小化", "Minimize")))?,
        &PredefinedMenuItem::maximize(app, Some(l("缩放", "Zoom")))?,
    ])?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}
