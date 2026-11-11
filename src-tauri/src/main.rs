// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Agent 拉起的 MCP server：不开窗口，只在 stdio 和正在运行的 App 之间转发
    if std::env::args().skip(1).any(|a| a == "--mcp") {
        excalidesk_lib::mcp::bridge::run();
    }
    excalidesk_lib::run()
}
