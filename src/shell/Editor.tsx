// 当前标签的 Excalidraw 实例。按 path 作 key：切标签 = 重新挂载（一个窗口只有一个 WebView 内的画布实例）。
// props 只有 session 和 theme，外壳其他状态变化不会让它重渲染。
import { memo, useCallback, useEffect, useMemo } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { DocSession } from "./session";
import { exportActive } from "./actions";

const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false as const, saveAsImage: false, toggleTheme: null },
};

function EditorImpl({ session, theme }: { session: DocSession; theme: "light" | "dark" }) {
  const initialData = useMemo(() => session.initialData(), [session]);
  const onApi = useCallback((api: unknown) => session.attach(api), [session]);
  useEffect(() => () => session.attach(null), [session]);
  return (
    <Excalidraw
      key={session.path}
      initialData={initialData as any}
      excalidrawAPI={onApi}
      onChange={session.onChange as any}
      onScrollChange={session.onScroll as any}
      theme={theme}
      UIOptions={UI_OPTIONS}
      langCode="zh-CN"
    >
      <MainMenu>
        <MainMenu.Item onSelect={() => exportActive("png")} shortcut="⇧⌘E">导出 PNG…</MainMenu.Item>
        <MainMenu.Item onSelect={() => exportActive("svg")}>导出 SVG…</MainMenu.Item>
        <MainMenu.Separator />
        <MainMenu.DefaultItems.ClearCanvas />
        <MainMenu.DefaultItems.ChangeCanvasBackground />
        <MainMenu.Separator />
        <MainMenu.DefaultItems.Help />
      </MainMenu>
    </Excalidraw>
  );
}

export const Editor = memo(EditorImpl);
