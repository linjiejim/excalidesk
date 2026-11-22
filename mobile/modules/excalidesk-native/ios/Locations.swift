import Foundation
import UIKit
import UniformTypeIdentifiers

/// A folder (or a single file opened from the Files app) the user granted access to.
/// Persisted as a security-scoped bookmark so it survives restarts.
struct LocationRecord: Codable {
  let id: String
  var name: String
  var bookmark: Data
  let isFile: Bool
  let addedAt: Double
}

enum LocationError: LocalizedError {
  case notFound
  case unreadable(String)
  case notExcalidraw

  var errorDescription: String? {
    switch self {
    case .notFound: return "location_not_found"
    case .unreadable(let why): return why
    case .notExcalidraw: return "not_excalidraw"
    }
  }
}

final class LocationStore {
  static let shared = LocationStore()
  private let key = "excalidesk.locations.v1"
  private let lock = NSLock()

  func all() -> [LocationRecord] {
    lock.lock(); defer { lock.unlock() }
    return load()
  }

  private func load() -> [LocationRecord] {
    guard let data = UserDefaults.standard.data(forKey: key),
          let list = try? JSONDecoder().decode([LocationRecord].self, from: data) else { return [] }
    return list
  }

  private func save(_ list: [LocationRecord]) {
    if let data = try? JSONEncoder().encode(list) {
      UserDefaults.standard.set(data, forKey: key)
    }
  }

  /// Adds a folder or file the user just picked (the URL must still be inside its security scope).
  /// Picking something already added returns the existing record.
  func add(url: URL, isFile: Bool) throws -> LocationRecord {
    let bookmark = try url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    lock.lock(); defer { lock.unlock() }
    var list = load()
    let path = url.standardizedFileURL.path
    for (i, rec) in list.enumerated() {
      if let existing = try? resolve(rec), existing.standardizedFileURL.path == path {
        list[i].bookmark = bookmark
        save(list)
        return list[i]
      }
    }
    let name = isFile ? url.deletingPathExtension().lastPathComponent : displayName(for: url)
    let rec = LocationRecord(id: (isFile ? "file-" : "dir-") + UUID().uuidString, name: name, bookmark: bookmark,
                             isFile: isFile, addedAt: Date().timeIntervalSince1970 * 1000)
    list.append(rec)
    save(list)
    return rec
  }

  func remove(id: String) {
    lock.lock(); defer { lock.unlock() }
    save(load().filter { $0.id != id })
  }

  func record(id: String) -> LocationRecord? {
    all().first { $0.id == id }
  }

  private func resolve(_ rec: LocationRecord) throws -> URL {
    var stale = false
    let url = try URL(resolvingBookmarkData: rec.bookmark, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    if stale, url.startAccessingSecurityScopedResource() {
      defer { url.stopAccessingSecurityScopedResource() }
      if let fresh = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil) {
        var list = load()
        if let i = list.firstIndex(where: { $0.id == rec.id }) {
          list[i].bookmark = fresh
          save(list)
        }
      }
    }
    return url
  }

  /// Runs `body` with the location's root URL inside its security scope.
  func withAccess<T>(_ id: String, _ body: (URL) throws -> T) throws -> T {
    guard let rec = record(id: id) else { throw LocationError.notFound }
    let url: URL
    do { url = try resolve(rec) } catch { throw LocationError.unreadable("bookmark_invalid") }
    let scoped = url.startAccessingSecurityScopedResource()
    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
    return try body(url)
  }

  private func displayName(for url: URL) -> String {
    (try? url.resourceValues(forKeys: [.localizedNameKey]).localizedName) ?? url.lastPathComponent
  }

  func isUbiquitous(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isUbiquitousItemKey]).isUbiquitousItem) ?? false
  }
}

// MARK: - Listing

struct FileEntry {
  let locationId: String
  let path: String
  let name: String
  let size: Int
  let modified: Double
  let isCloud: Bool
  let downloaded: Bool

  var dict: [String: Any] {
    [
      "id": "\(locationId):\(path)",
      "locationId": locationId,
      "path": path,
      "name": name,
      "size": size,
      "modified": modified,
      "isCloud": isCloud,
      "downloaded": downloaded,
    ]
  }
}

enum Listing {
  static let keys: Set<URLResourceKey> = [
    .isDirectoryKey, .isHiddenKey, .contentModificationDateKey, .fileSizeKey, .totalFileSizeKey,
    .isUbiquitousItemKey, .ubiquitousItemDownloadingStatusKey, .localizedNameKey,
  ]

  /// `.Name.excalidraw.icloud` placeholders (older iCloud Drive) → the real file name, not downloaded yet.
  static func realName(_ name: String) -> (String, Bool) {
    if name.hasPrefix("."), name.hasSuffix(".icloud") {
      return (String(name.dropFirst().dropLast(".icloud".count)), true)
    }
    return (name, false)
  }

  static func isDrawing(_ name: String) -> Bool {
    name.lowercased().hasSuffix(".excalidraw")
  }

  static func entry(locationId: String, root: URL, url: URL) -> FileEntry? {
    let (name, placeholder) = realName(url.lastPathComponent)
    guard isDrawing(name) else { return nil }
    let values = try? url.resourceValues(forKeys: keys)
    let isCloud = placeholder || (values?.isUbiquitousItem ?? false)
    let status = values?.ubiquitousItemDownloadingStatus
    let downloaded = !placeholder && (!isCloud || status == .current || status == .downloaded || status == nil)
    let dir = url.deletingLastPathComponent()
    let relDir = relative(dir, to: root)
    let path = relDir.isEmpty ? name : "\(relDir)/\(name)"
    return FileEntry(
      locationId: locationId,
      path: path,
      name: (name as NSString).deletingPathExtension,
      size: values?.totalFileSize ?? values?.fileSize ?? 0,
      modified: (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000,
      isCloud: isCloud,
      downloaded: downloaded
    )
  }

  static func relative(_ url: URL, to root: URL) -> String {
    let r = root.standardizedFileURL.path
    let p = url.standardizedFileURL.path
    if p == r { return "" }
    if p.hasPrefix(r + "/") { return String(p.dropFirst(r.count + 1)) }
    return url.lastPathComponent
  }

  private static func children(of dir: URL) -> [URL] {
    (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: Array(keys), options: [])) ?? []
  }

  private static func isDir(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
  }

  /// One level: subfolders (with how many drawings they hold, recursively) and drawings.
  static func list(locationId: String, root: URL, subpath: String) -> [String: Any] {
    let dir = subpath.isEmpty ? root : root.appendingPathComponent(subpath, isDirectory: true)
    var folders: [[String: Any]] = []
    var files: [[String: Any]] = []
    for url in children(of: dir) {
      let name = url.lastPathComponent
      if isDir(url) {
        if name.hasPrefix(".") || name.hasSuffix(".app") { continue }
        let count = countDrawings(in: url, depth: 0)
        let rel = relative(url, to: root)
        let modified = ((try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
        folders.append(["name": name, "path": rel, "count": count, "modified": modified])
      } else if name.hasPrefix("."), !name.hasSuffix(".icloud") {
        continue
      } else if let e = entry(locationId: locationId, root: root, url: url) {
        files.append(e.dict)
      }
    }
    return ["folders": folders, "files": files]
  }

  static func countDrawings(in dir: URL, depth: Int) -> Int {
    if depth > 6 { return 0 }
    var n = 0
    for url in children(of: dir) {
      let name = url.lastPathComponent
      if isDir(url) {
        if !name.hasPrefix(".") { n += countDrawings(in: url, depth: depth + 1) }
      } else if isDrawing(realName(name).0) {
        n += 1
      }
    }
    return n
  }

  /// Every drawing under the location (for Recents and Search).
  static func scan(locationId: String, root: URL, limit: Int = 3000) -> [[String: Any]] {
    var out: [[String: Any]] = []
    func walk(_ dir: URL, _ depth: Int) {
      if depth > 8 || out.count >= limit { return }
      for url in children(of: dir) {
        let name = url.lastPathComponent
        if isDir(url) {
          if !name.hasPrefix(".") { walk(url, depth + 1) }
        } else if let e = entry(locationId: locationId, root: root, url: url) {
          out.append(e.dict)
        }
      }
    }
    walk(root, 0)
    return out
  }
}

// MARK: - Reading

enum FileAccess {
  /// The URL of a file reference, plus whether it lives in iCloud.
  static func url(locationId: String, path: String, root: URL, isFile: Bool) -> URL {
    if isFile || path.isEmpty { return root }
    return root.appendingPathComponent(path, isDirectory: false)
  }

  /// Reads a drawing with file coordination; iCloud files that aren't on the device are downloaded first.
  static func read(_ url: URL) throws -> Data {
    let fm = FileManager.default
    var target = url
    let (_, placeholder) = Listing.realName(url.lastPathComponent)
    if placeholder {
      let real = url.deletingLastPathComponent().appendingPathComponent(Listing.realName(url.lastPathComponent).0)
      target = real
    }
    if fm.isUbiquitousItem(at: target) {
      try? fm.startDownloadingUbiquitousItem(at: target)
    }
    var coordError: NSError?
    var result: Result<Data, Error> = .failure(LocationError.unreadable("read_failed"))
    NSFileCoordinator(filePresenter: nil).coordinate(readingItemAt: target, options: [], error: &coordError) { readURL in
      result = Result { try Data(contentsOf: readURL, options: [.mappedIfSafe]) }
    }
    if let coordError { throw coordError }
    return try result.get()
  }

  /// Modification date (ms) and size, for cache keys.
  static func stamp(_ url: URL) -> (Double, Int) {
    let v = try? url.resourceValues(forKeys: [.contentModificationDateKey, .fileSizeKey, .totalFileSizeKey])
    return ((v?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000, v?.totalFileSize ?? v?.fileSize ?? 0)
  }
}

// MARK: - Folder picker

final class FolderPicker: NSObject, UIDocumentPickerDelegate {
  private var completion: ((URL?) -> Void)?
  private static var current: FolderPicker?

  static func present(completion: @escaping (URL?) -> Void) {
    let picker = FolderPicker()
    picker.completion = completion
    current = picker
    let vc = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
    vc.delegate = picker
    vc.allowsMultipleSelection = false
    vc.shouldShowFileExtensions = true
    guard let top = topViewController() else {
      completion(nil)
      current = nil
      return
    }
    top.present(vc, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    completion?(urls.first)
    completion = nil
    FolderPicker.current = nil
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    completion?(nil)
    completion = nil
    FolderPicker.current = nil
  }
}

func topViewController() -> UIViewController? {
  let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
  let window = scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? scenes.first?.windows.first
  var top = window?.rootViewController
  while let presented = top?.presentedViewController, !presented.isBeingDismissed {
    top = presented
  }
  return top
}
