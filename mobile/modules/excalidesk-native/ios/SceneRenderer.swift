import CryptoKit
import Foundation
import PDFKit
import UIKit
import WebKit

/// What a drawing turned into: a vector PDF (whole canvas, or one page per slide), a thumbnail, and a summary.
struct RenderedScene {
  var meta: [String: Any]
  var pdf: URL?
  var slidesPdf: URL?
  var thumbnail: URL?

  var dict: [String: Any] {
    var d = meta
    if let pdf { d["pdf"] = pdf.absoluteString }
    if let slidesPdf { d["slidesPdf"] = slidesPdf.absoluteString }
    if let thumbnail { d["thumbnail"] = thumbnail.absoluteString }
    return d
  }
}

struct RenderRequest {
  let locationId: String
  let path: String
  let dark: Bool
  /// "meta" (summary only, for search), "canvas" (PDF + thumbnail), "slides" (also one page per slide)
  let want: String
  let high: Bool
}

/// Renders .excalidraw files with the real Excalidraw (bundled offline) inside a hidden WKWebView,
/// then turns the SVG into a vector PDF with WKWebView.createPDF. Results are cached on disk by
/// file identity + modification date + size, so each drawing renders once.
@MainActor
final class SceneRenderer {
  static let shared = SceneRenderer()
  /// Bump when the renderer output changes, to invalidate old caches.
  nonisolated static let version = 4

  private var webView: WKWebView?
  private var watcher: NavigationWatcher?
  private var booting: Task<WKWebView, Error>?
  private var busy = false
  private var high: [() async -> Void] = []
  private var low: [() async -> Void] = []
  private var inflight: [String: Task<RenderedScene, Error>] = [:]

  // MARK: Cache

  nonisolated static var cacheRoot: URL {
    let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
      .appendingPathComponent("Renders", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
  }

  nonisolated static func fileHash(_ locationId: String, _ path: String) -> String {
    let digest = SHA256.hash(data: Data("\(locationId)|\(path)".utf8))
    return digest.prefix(10).map { String(format: "%02x", $0) }.joined()
  }

  nonisolated static func cacheDir(_ locationId: String, _ path: String, modified: Double, size: Int) -> URL {
    cacheRoot.appendingPathComponent("\(fileHash(locationId, path))-\(Int(modified))-\(size)-v\(version)", isDirectory: true)
  }

  /// Whatever is already rendered for this file version, without doing any work.
  nonisolated static func cached(_ locationId: String, _ path: String, modified: Double, size: Int, dark: Bool) -> RenderedScene? {
    let dir = cacheDir(locationId, path, modified: modified, size: size)
    guard let data = try? Data(contentsOf: dir.appendingPathComponent("meta.json")),
          let meta = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let theme = dark ? "dark" : "light"
    let fm = FileManager.default
    let pdf = dir.appendingPathComponent("\(theme).pdf")
    let slides = dir.appendingPathComponent("\(theme)-slides.pdf")
    let thumb = dir.appendingPathComponent("\(theme).png")
    return RenderedScene(
      meta: meta,
      pdf: fm.fileExists(atPath: pdf.path) ? pdf : nil,
      slidesPdf: fm.fileExists(atPath: slides.path) ? slides : nil,
      thumbnail: fm.fileExists(atPath: thumb.path) ? thumb : nil
    )
  }

  nonisolated static func clearCache() {
    try? FileManager.default.removeItem(at: cacheRoot)
  }

  /// Drops renders of older versions of the same file.
  private nonisolated static func pruneOlder(than dir: URL, hash: String) {
    let fm = FileManager.default
    guard let items = try? fm.contentsOfDirectory(at: cacheRoot, includingPropertiesForKeys: nil) else { return }
    for item in items where item.lastPathComponent.hasPrefix(hash + "-") && item.lastPathComponent != dir.lastPathComponent {
      try? fm.removeItem(at: item)
    }
  }

  // MARK: Queue (one web view, viewer requests jump ahead of background thumbnails)

  private func enqueue(high isHigh: Bool, _ work: @escaping () async -> Void) {
    if isHigh { high.append(work) } else { low.append(work) }
    pump()
  }

  private func pump() {
    guard !busy else { return }
    let next: (() async -> Void)?
    if !high.isEmpty { next = high.removeFirst() } else if !low.isEmpty { next = low.removeFirst() } else { next = nil }
    guard let next else { return }
    busy = true
    Task { @MainActor in
      await next()
      self.busy = false
      self.pump()
    }
  }

  private func run<T>(high isHigh: Bool, _ body: @escaping () async throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { (cont: CheckedContinuation<T, Error>) in
      enqueue(high: isHigh) {
        do { cont.resume(returning: try await body()) } catch { cont.resume(throwing: error) }
      }
    }
  }

  // MARK: Public

  func render(_ req: RenderRequest) async throws -> RenderedScene {
    let (url, isFile) = try resolveURL(req.locationId, req.path)
    let (modified, size) = try LocationStore.shared.withAccess(req.locationId) { _ in FileAccess.stamp(url) }
    _ = isFile
    if let hit = Self.cached(req.locationId, req.path, modified: modified, size: size, dark: req.dark), satisfies(hit, req.want) {
      return hit
    }
    let key = "\(Self.fileHash(req.locationId, req.path))-\(Int(modified))-\(size)-\(req.dark)-\(req.want)"
    if let running = inflight[key] { return try await running.value }
    let task = Task { @MainActor () throws -> RenderedScene in
      defer { self.inflight[key] = nil }
      return try await self.run(high: req.high) {
        try await self.renderNow(req, url: url, modified: modified, size: size)
      }
    }
    inflight[key] = task
    return try await task.value
  }

  private func satisfies(_ r: RenderedScene, _ want: String) -> Bool {
    switch want {
    case "meta": return true
    case "slides": return r.pdf != nil && r.thumbnail != nil && r.slidesPdf != nil
    default: return r.pdf != nil && r.thumbnail != nil
    }
  }

  private func resolveURL(_ locationId: String, _ path: String) throws -> (URL, Bool) {
    guard let rec = LocationStore.shared.record(id: locationId) else { throw LocationError.notFound }
    let url = try LocationStore.shared.withAccess(locationId) { root in
      FileAccess.url(locationId: locationId, path: path, root: root, isFile: rec.isFile)
    }
    return (url, rec.isFile)
  }

  private func renderNow(_ req: RenderRequest, url: URL, modified: Double, size: Int) async throws -> RenderedScene {
    let dir = Self.cacheDir(req.locationId, req.path, modified: modified, size: size)
    let fm = FileManager.default
    try fm.createDirectory(at: dir, withIntermediateDirectories: true)
    let existing = Self.cached(req.locationId, req.path, modified: modified, size: size, dark: req.dark)
    if let existing, satisfies(existing, req.want) { return existing }

    // Read off the main thread (may wait for an iCloud download)
    let locationId = req.locationId
    let data = try await Task.detached(priority: req.high ? .userInitiated : .utility) {
      try LocationStore.shared.withAccess(locationId) { _ in try FileAccess.read(url) }
    }.value
    guard let json = String(data: data, encoding: .utf8) else { throw LocationError.notExcalidraw }

    let wv = try await ensureWebView()
    let loaded = try await call(wv, "return window.excalidesk.load(json)", ["json": json])
    guard var meta = loaded as? [String: Any] else { throw LocationError.notExcalidraw }
    meta["modified"] = modified
    meta["size"] = size
    if let metaData = try? JSONSerialization.data(withJSONObject: meta) {
      try? metaData.write(to: dir.appendingPathComponent("meta.json"), options: .atomic)
    }
    Self.pruneOlder(than: dir, hash: Self.fileHash(req.locationId, req.path))
    if req.want == "meta" {
      return RenderedScene(meta: meta, pdf: existing?.pdf, slidesPdf: existing?.slidesPdf, thumbnail: existing?.thumbnail)
    }

    let theme = req.dark ? "dark" : "light"
    let pdfURL = dir.appendingPathComponent("\(theme).pdf")
    let thumbURL = dir.appendingPathComponent("\(theme).png")
    if !fm.fileExists(atPath: pdfURL.path) || !fm.fileExists(atPath: thumbURL.path) {
      let page = try await pdfPage(wv, frameId: nil, dark: req.dark)
      let doc = PDFDocument()
      doc.insert(page, at: 0)
      if !doc.write(to: pdfURL) { throw LocationError.unreadable("pdf_write_failed") }
      let thumb = page.thumbnail(of: CGSize(width: 640, height: 480), for: .cropBox)
      try? thumb.pngData()?.write(to: thumbURL, options: .atomic)
    }

    var slidesURL: URL? = nil
    let slides = (meta["slides"] as? [[String: Any]]) ?? []
    if req.want == "slides", !slides.isEmpty {
      let target = dir.appendingPathComponent("\(theme)-slides.pdf")
      if !fm.fileExists(atPath: target.path) {
        let doc = PDFDocument()
        for slide in slides {
          guard let id = slide["id"] as? String else { continue }
          let page = try await pdfPage(wv, frameId: id, dark: req.dark)
          doc.insert(page, at: doc.pageCount)
        }
        if !doc.write(to: target) { throw LocationError.unreadable("slides_write_failed") }
      }
      slidesURL = target
    }
    _ = try? await call(wv, "window.excalidesk.clear()", [:])
    wv.frame = CGRect(x: 0, y: 0, width: 64, height: 64)
    return RenderedScene(meta: meta, pdf: pdfURL, slidesPdf: slidesURL ?? existing?.slidesPdf,
                         thumbnail: fm.fileExists(atPath: thumbURL.path) ? thumbURL : nil)
  }

  /// One page, cropped half a point on every side: WebKit's PDF can leave a sub-pixel strip of
  /// unpainted page at the edges, which PDFKit shows as a hairline against the canvas color.
  private func pdfPage(_ wv: WKWebView, frameId: String?, dark: Bool) async throws -> PDFPage {
    let data = try await pdfData(wv, frameId: frameId, dark: dark)
    guard let page = PDFDocument(data: data)?.page(at: 0) else { throw LocationError.unreadable("pdf_failed") }
    let media = page.bounds(for: .mediaBox)
    page.setBounds(media.insetBy(dx: 0.5, dy: 0.5), for: .cropBox)
    return page
  }

  private func pdfData(_ wv: WKWebView, frameId: String?, dark: Bool) async throws -> Data {
    var args: [String: Any] = ["dark": dark]
    args["frameId"] = frameId ?? NSNull()
    let result = try await call(wv, "return await window.excalidesk.render({ frameId, dark })", args)
    guard let size = result as? [String: Any],
          let w = (size["width"] as? NSNumber)?.doubleValue,
          let h = (size["height"] as? NSNumber)?.doubleValue else {
      throw LocationError.unreadable("render_failed")
    }
    wv.frame = CGRect(x: 0, y: 0, width: ceil(w), height: ceil(h))
    wv.layoutIfNeeded()
    let config = WKPDFConfiguration()
    config.rect = CGRect(x: 0, y: 0, width: w, height: h)
    return try await wv.pdf(configuration: config)
  }

  private func call(_ wv: WKWebView, _ js: String, _ args: [String: Any]) async throws -> Any? {
    try await wv.callAsyncJavaScript(js, arguments: args, in: nil, contentWorld: .page)
  }

  // MARK: Web view

  func warmUp() {
    Task { @MainActor in _ = try? await self.ensureWebView() }
  }

  private func ensureWebView() async throws -> WKWebView {
    if let webView { return webView }
    if let booting { return try await booting.value }
    let task = Task { @MainActor () throws -> WKWebView in
      guard let root = Self.rendererRoot() else { throw LocationError.unreadable("renderer_missing") }
      let config = WKWebViewConfiguration()
      config.setURLSchemeHandler(BundleSchemeHandler(root: root), forURLScheme: BundleSchemeHandler.scheme)
      config.suppressesIncrementalRendering = true
      let wv = WKWebView(frame: CGRect(x: 0, y: 0, width: 64, height: 64), configuration: config)
      wv.isUserInteractionEnabled = false
      wv.scrollView.contentInsetAdjustmentBehavior = .never
      #if DEBUG
      if #available(iOS 16.4, *) { wv.isInspectable = true }
      #endif
      // Keep it in a window (behind everything) so WebKit treats the page as visible and doesn't throttle it
      if let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
        .flatMap({ $0.windows }).first(where: { $0.isKeyWindow }) {
        window.insertSubview(wv, at: 0)
      }
      let watcher = NavigationWatcher()
      wv.navigationDelegate = watcher
      self.watcher = watcher
      wv.load(URLRequest(url: URL(string: "\(BundleSchemeHandler.scheme)://app/index.html")!))
      let deadline = Date().addingTimeInterval(20)
      var lastError = ""
      while Date() < deadline {
        do {
          // callAsyncJavaScript, not evaluateJavaScript: the async evaluateJavaScript overload hands back `()` instead of the value
          let ready = try await call(wv, "return !!(window.excalidesk && window.excalidesk.ready === true)", [:])
          if (ready as? Bool) == true || (ready as? NSNumber)?.boolValue == true {
            self.webView = wv
            return wv
          }
        } catch {
          lastError = String(describing: error)
        }
        try await Task.sleep(nanoseconds: 50_000_000)
      }
      var why = "nav=\(watcher.log.joined(separator: "; ")) eval=\(lastError)"
      if let page = try? await call(wv, "return JSON.stringify({ url: location.href, state: document.readyState, errors: window.__errors || [], hasApi: !!window.excalidesk })", [:]) {
        why += " page=\(page ?? "")"
      }
      wv.removeFromSuperview()
      throw LocationError.unreadable("renderer_timeout \(why)")
    }
    booting = task
    do {
      let wv = try await task.value
      booting = nil
      return wv
    } catch {
      booting = nil
      throw error
    }
  }

  nonisolated static func rendererRoot() -> URL? {
    let candidates = [Bundle.main, Bundle(for: BundleSchemeHandler.self)]
    for bundle in candidates {
      if let url = bundle.url(forResource: "ExcalideskRenderer", withExtension: "bundle"),
         let inner = Bundle(url: url)?.url(forResource: "renderer", withExtension: nil) {
        return inner
      }
    }
    return nil
  }
}

/// Serves the bundled renderer (HTML, JS chunks, fonts) to the hidden web view, fully offline.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
  static let scheme = "excalidesk-renderer"
  let root: URL

  init(root: URL) {
    self.root = root.standardizedFileURL
  }

  func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
    guard let url = task.request.url else { return }
    var path = url.path
    if path.isEmpty || path == "/" { path = "/index.html" }
    let file = root.appendingPathComponent(String(path.dropFirst())).standardizedFileURL
    guard file.path.hasPrefix(root.path + "/"), let data = try? Data(contentsOf: file) else {
      task.didFailWithError(URLError(.fileDoesNotExist))
      return
    }
    let headers = [
      "Content-Type": Self.mime(file.pathExtension),
      "Content-Length": String(data.count),
      "Access-Control-Allow-Origin": "*",
    ]
    let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers)!
    task.didReceive(response)
    task.didReceive(data)
    task.didFinish()
  }

  func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}

  static func mime(_ ext: String) -> String {
    switch ext.lowercased() {
    case "html": return "text/html; charset=utf-8"
    case "js", "mjs": return "text/javascript; charset=utf-8"
    case "css": return "text/css; charset=utf-8"
    case "json": return "application/json"
    case "woff2": return "font/woff2"
    case "woff": return "font/woff"
    case "ttf": return "font/ttf"
    case "wasm": return "application/wasm"
    case "svg": return "image/svg+xml"
    case "png": return "image/png"
    default: return "application/octet-stream"
    }
  }
}

/// Records why the renderer page failed to load (shown in the timeout error).
final class NavigationWatcher: NSObject, WKNavigationDelegate {
  var log: [String] = []

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    log.append("finish")
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    log.append("fail: \(error.localizedDescription)")
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    log.append("provisional fail: \(error.localizedDescription)")
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    log.append("web process terminated")
  }
}
