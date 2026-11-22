import ExpoModulesCore
import UIKit

struct RenderOptions: Record {
  @Field var dark: Bool = false
  /// "meta" | "canvas" | "slides"
  @Field var want: String = "canvas"
  /// "high" (the viewer) | "low" (thumbnails, search index)
  @Field var priority: String = "high"
}

public class ExcalideskNativeModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExcalideskNative")

    OnCreate {
      // Boot the renderer early so the first drawing opens fast
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
        Task { @MainActor in SceneRenderer.shared.warmUp() }
      }
    }

    // MARK: Small persistent values (recents, preferences) — JSON strings in UserDefaults

    Function("getValue") { (key: String) -> String? in
      UserDefaults.standard.string(forKey: "excalidesk.kv.\(key)")
    }

    Function("setValue") { (key: String, value: String?) in
      if let value {
        UserDefaults.standard.set(value, forKey: "excalidesk.kv.\(key)")
      } else {
        UserDefaults.standard.removeObject(forKey: "excalidesk.kv.\(key)")
      }
    }

    // MARK: Locations

    Function("listLocations") { () -> [[String: Any]] in
      LocationStore.shared.all().map { Self.locationDict($0) }
    }

    AsyncFunction("pickFolder") { (promise: Promise) in
      FolderPicker.present { url in
        guard let url else {
          promise.resolve(nil)
          return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
          let rec = try LocationStore.shared.add(url: url, isFile: false)
          promise.resolve(Self.locationDict(rec))
        } catch {
          promise.reject("ERR_PICK_FOLDER", error.localizedDescription)
        }
      }
    }.runOnQueue(.main)

    Function("removeLocation") { (id: String) in
      LocationStore.shared.remove(id: id)
    }

    AsyncFunction("listFolder") { (locationId: String, path: String) throws -> [String: Any] in
      guard let rec = LocationStore.shared.record(id: locationId) else { throw LocationError.notFound }
      return try LocationStore.shared.withAccess(locationId) { root in
        if rec.isFile {
          return ["folders": [], "files": [Self.fileEntry(rec, root: root)].compactMap { $0 }]
        }
        return Listing.list(locationId: locationId, root: root, subpath: path)
      }
    }

    AsyncFunction("scanLocation") { (locationId: String) throws -> [[String: Any]] in
      guard let rec = LocationStore.shared.record(id: locationId) else { throw LocationError.notFound }
      return try LocationStore.shared.withAccess(locationId) { root in
        if rec.isFile { return [Self.fileEntry(rec, root: root)].compactMap { $0 } }
        return Listing.scan(locationId: locationId, root: root)
      }
    }

    /// A .excalidraw file handed to us by the Files app ("Open in Excalidesk"), opened in place.
    AsyncFunction("openExternal") { (uri: String) throws -> [String: Any] in
      guard let url = URL(string: uri) else { throw LocationError.unreadable("bad_url") }
      let scoped = url.startAccessingSecurityScopedResource()
      defer { if scoped { url.stopAccessingSecurityScopedResource() } }
      let rec = try LocationStore.shared.add(url: url, isFile: true)
      guard let entry = try LocationStore.shared.withAccess(rec.id, { root in Self.fileEntry(rec, root: root) }) else {
        throw LocationError.notExcalidraw
      }
      return entry
    }

    // MARK: Rendering

    AsyncFunction("render") { (locationId: String, path: String, options: RenderOptions) async throws -> [String: Any] in
      let req = RenderRequest(locationId: locationId, path: path, dark: options.dark, want: options.want,
                              high: options.priority != "low")
      return try await SceneRenderer.shared.render(req).dict
    }

    Function("cached") { (locationId: String, path: String, modified: Double, size: Int, dark: Bool) -> [String: Any]? in
      SceneRenderer.cached(locationId, path, modified: modified, size: size, dark: dark)?.dict
    }

    Function("clearCache") {
      SceneRenderer.clearCache()
    }

    // MARK: Sharing

    /// System share sheet with the original .excalidraw ("original") or the rendered PDF ("pdf").
    AsyncFunction("share") { (locationId: String, path: String, kind: String, pdfUri: String?, title: String, promise: Promise) in
      let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("share", isDirectory: true)
      try? FileManager.default.removeItem(at: tmp)
      try? FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
      let safe = title.replacingOccurrences(of: "/", with: "-")
      var item: URL?
      do {
        if kind == "pdf", let pdfUri, let src = URL(string: pdfUri) {
          let dst = tmp.appendingPathComponent("\(safe).pdf")
          try FileManager.default.copyItem(at: src, to: dst)
          item = dst
        } else if let rec = LocationStore.shared.record(id: locationId) {
          let data = try LocationStore.shared.withAccess(locationId) { root in
            try FileAccess.read(FileAccess.url(locationId: locationId, path: path, root: root, isFile: rec.isFile))
          }
          let dst = tmp.appendingPathComponent("\(safe).excalidraw")
          try data.write(to: dst)
          item = dst
        }
      } catch {
        promise.reject("ERR_SHARE", error.localizedDescription)
        return
      }
      guard let item, let top = topViewController() else {
        promise.resolve(false)
        return
      }
      let sheet = UIActivityViewController(activityItems: [item], applicationActivities: nil)
      if let pop = sheet.popoverPresentationController {
        pop.sourceView = top.view
        pop.sourceRect = CGRect(x: top.view.bounds.maxX - 60, y: 60, width: 1, height: 1)
      }
      sheet.completionWithItemsHandler = { _, completed, _, _ in promise.resolve(completed) }
      top.present(sheet, animated: true)
    }.runOnQueue(.main)

    // MARK: Canvas view

    View(DrawingView.self) {
      Events("onSingleTap", "onZoomChange", "onPageChange", "onReady")

      Prop("source") { (view: DrawingView, uri: String?) in
        view.setSource(uri)
      }
      Prop("paged") { (view: DrawingView, value: Bool?) in
        view.setPaged(value ?? false)
      }
      Prop("canvasColor") { (view: DrawingView, color: UIColor?) in
        view.setCanvasColor(color)
      }
      Prop("initialPage") { (view: DrawingView, index: Int?) in
        view.setInitialPage(index ?? 0)
      }

      AsyncFunction("fit") { (view: DrawingView) in
        view.fit(animated: true)
      }.runOnQueue(.main)

      AsyncFunction("goToPage") { (view: DrawingView, index: Int) in
        view.goToPage(index, animated: true)
      }.runOnQueue(.main)
    }
  }

  static func locationDict(_ rec: LocationRecord) -> [String: Any] {
    var isCloud = false
    var available = true
    do {
      try LocationStore.shared.withAccess(rec.id) { root in
        isCloud = LocationStore.shared.isUbiquitous(root) || root.path.contains("/Mobile Documents/")
          || root.path.contains("com~apple~CloudDocs")
        available = FileManager.default.fileExists(atPath: root.path)
      }
    } catch {
      available = false
    }
    return ["id": rec.id, "name": rec.name, "isFile": rec.isFile, "isCloud": isCloud, "available": available, "addedAt": rec.addedAt]
  }

  static func fileEntry(_ rec: LocationRecord, root: URL) -> [String: Any]? {
    guard let e = Listing.entry(locationId: rec.id, root: root.deletingLastPathComponent(), url: root) else { return nil }
    return FileEntry(locationId: rec.id, path: "", name: e.name, size: e.size, modified: e.modified,
                     isCloud: e.isCloud, downloaded: e.downloaded).dict
  }
}
