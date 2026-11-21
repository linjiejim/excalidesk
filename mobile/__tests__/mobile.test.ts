import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeSceneBounds,
  extractSlides,
  extractThumbnailPrimitives,
  isNotesFrame,
  parseExcalidrawJson,
  summarizeScene,
} from "../src/lib/excalidraw.ts";
import { parseMobileCollabLink } from "../src/lib/collabLinks.ts";
import { SAMPLE_DRAWINGS } from "../src/lib/samples.ts";
import { buildViewerHtml } from "../src/lib/viewerHtml.ts";

describe("Excalidesk Mobile Core", () => {
  it("parses .excalidraw JSON and ignores deleted tombstones", () => {
    const raw = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "r1", type: "rectangle", x: 10, y: 20, width: 100, height: 50 },
        { id: "r2", type: "rectangle", x: 500, y: 500, width: 50, height: 50, isDeleted: true },
        { id: "t1", type: "text", x: 20, y: 30, width: 80, height: 20, text: "Hello iCloud" },
      ],
      appState: { viewBackgroundColor: "#fdfdfd" },
      files: {},
    });

    const scene = parseExcalidrawJson(raw);
    const summary = summarizeScene(scene);
    assert.equal(summary.liveCount, 2);
    assert.equal(summary.backgroundColor, "#fdfdfd");
    assert.ok(summary.searchText.includes("Hello iCloud"));
    assert.deepEqual(computeSceneBounds(scene.elements), { x: 10, y: 20, w: 100, h: 50 });
  });

  it("extracts slides in row-major order and pairs speaker notes accurately", () => {
    const raw = JSON.stringify({
      type: "excalidraw",
      version: 2,
      elements: [
        { id: "fB", type: "frame", name: "B", x: 1200, y: 0, width: 800, height: 450, customData: { excalidesk: { slide: true } } },
        { id: "fA", type: "frame", name: "Notes app redesign", x: 0, y: 0, width: 800, height: 450, customData: { excalidesk: { slide: true } } },
        { id: "fC", type: "frame", name: "C", x: 0, y: 800, width: 800, height: 450 },
        { id: "nA", type: "frame", name: "Notes", x: 0, y: 500, width: 800, height: 200, customData: { excalidesk: { notesFor: "fA" } } },
        { id: "nAText", type: "text", frameId: "nA", x: 20, y: 520, width: 600, height: 40, text: "Speaker note for A" },
      ],
    });

    const scene = parseExcalidrawJson(raw);
    // Fixed slide named "Notes app redesign" must NOT be treated as a notes frame
    assert.equal(isNotesFrame(scene.elements[1]), false);
    assert.equal(isNotesFrame(scene.elements[3]), true);

    const slides = extractSlides(scene.elements);
    assert.deepEqual(
      slides.map((s) => s.id),
      ["fA", "fB", "fC"],
    );
    assert.equal(slides[0].notesText, "Speaker note for A");
    assert.equal(slides[1].notesText, "");
  });

  it("projects scenes into normalized native SVG thumbnail primitives", () => {
    const sample = SAMPLE_DRAWINGS[0];
    assert.ok(sample.rawJson);
    const scene = parseExcalidrawJson(sample.rawJson);
    const prims = extractThumbnailPrimitives(scene);
    assert.ok(prims.length >= 6);
    for (const p of prims) {
      if (p.kind === "rect") {
        assert.ok(p.x >= 0 && p.x <= 100);
        assert.ok(p.y >= 0 && p.y <= 64);
      }
    }
  });

  it("ships valid sample drawings including a multi-slide presentation with speaker notes", () => {
    assert.equal(SAMPLE_DRAWINGS.length, 2);
    const deck = SAMPLE_DRAWINGS.find((d) => d.id === "sample:slides");
    assert.ok(deck?.rawJson);
    const summary = summarizeScene(parseExcalidrawJson(deck.rawJson));
    assert.equal(summary.slideCount, 2);
    assert.ok(summary.slides[0].notesText.length > 10);
    assert.ok(summary.slides[1].notesText.includes("docker compose"));
  });

  it("parses share and live collaboration links on mobile", () => {
    const room = parseMobileCollabLink("https://draw.example.com/#room=rm_123456,k_abcdef");
    assert.deepEqual(room, {
      kind: "room",
      id: "rm_123456",
      key: "k_abcdef",
      serverUrl: "https://draw.example.com",
      readOnly: false,
    });

    const share = parseMobileCollabLink("excalidesk://open?server=https://draw.example.com#share=sh_999,k_xyz");
    assert.deepEqual(share, {
      kind: "share",
      id: "sh_999",
      key: "k_xyz",
      serverUrl: "https://draw.example.com",
      readOnly: true,
    });

    assert.equal(parseMobileCollabLink("https://example.com/not-a-collab-link"), null);
  });

  it("builds self-contained offline viewer HTML with no external CDN script tags", () => {
    const html = buildViewerHtml({ dark: true });
    assert.ok(html.includes("window.__excalidesk"));
    assert.ok(html.includes('class="dark"'));
    assert.equal(html.includes("https://cdn"), false);
    assert.equal(html.includes("unpkg.com"), false);
  });
});
