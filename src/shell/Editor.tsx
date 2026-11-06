// 当前标签的 Excalidraw 实例。按会话 uid 作 key：切标签 = 重新挂载，重命名不会（一个窗口只有一个画布实例）。
// props 只有 session、theme、lang，外壳其他状态变化不会让它重渲染。
import { memo, useCallback, useEffect, useMemo } from "react";
import { Excalidraw, MainMenu } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import type { DocSession } from "./session";
import { exportActive, toggleHistory } from "./actions";
import { t } from "./i18n";

const UI_OPTIONS = {
  canvasActions: { loadScene: false, saveToActiveFile: false, export: false as const, saveAsImage: false, toggleTheme: null },
};

function EditorImpl({ session, theme, lang }: { session: DocSession; theme: "light" | "dark"; lang: "zh" | "en" }) {
  const initialData = useMemo(() => session.initialData(), [session]);
  const onApi = useCallback((api: unknown) => session.attach(api), [session]);
  useEffect(() => () => session.attach(null), [session]);
  return (
    // 捕获阶段记录「用户动过画布」：之前 Excalidraw 自己的规整（重新测量文字等）不算改动
    <div className="excalidraw-host" onPointerDownCapture={session.userInput} onKeyDownCapture={session.userInput}>
      <Excalidraw
        key={session.uid}
        initialData={initialData as any}
        excalidrawAPI={onApi}
        onChange={session.onChange as any}
        onScrollChange={session.onScroll as any}
        theme={theme}
        UIOptions={UI_OPTIONS}
        langCode={lang === "zh" ? "zh-CN" : "en"}
      >
        <MainMenu>
          <MainMenu.Item onSelect={() => exportActive("png")} shortcut="⇧⌘E">{lang === "zh" ? "导出 PNG…" : "Export PNG…"}</MainMenu.Item>
          <MainMenu.Item onSelect={() => exportActive("svg")}>{lang === "zh" ? "导出 SVG…" : "Export SVG…"}</MainMenu.Item>
          <MainMenu.Item onSelect={() => toggleHistory(true)} shortcut="⌥⌘Y">{t("menu.history")}</MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.Help />
        </MainMenu>
      </Excalidraw>
    </div>
  );
}

export const Editor = memo(EditorImpl);
