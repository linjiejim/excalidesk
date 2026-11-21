import ExpoModulesCore
import Foundation
import UIKit
import UniformTypeIdentifiers

private struct SavedFolderRecord: Codable {
  let id: String
  let name: String
  let bookmarkBase64: String
  let isICloud: Bool
}

public class ICloudFilesModule: Module {
  private let storageKey = "dev.jim.excalidesk.icloud.savedFolders.v1"
  private var activePickerDelegate: FolderPickerDelegate?

  public func definition() -> ModuleDefinition {
    Name("ICloudFiles")

    Function("isICloudAvailable") { () -> Bool in
      return FileManager.default.ubiquityIdentityToken != nil
    }

    Function("listSavedFolders") { () -> [[String: Any]] in
      return self.loadRecords().map { record in
        [
          "id": record.id,
          "name": record.name,
          "isICloud": record.isICloud
        ]
      }
    }

    Function("removeSavedFolder") { (folderId: String) -> Bool in
      let before = self.loadRecords()
      let after = before.filter { $0.id != folderId }
      self.saveRecords(after)
      return before.count != after.count
    }

    AsyncFunction("pickFolder") { (promise: Promise) in
      DispatchQueue.main.async {
        guard let presenter = self.topViewController() else {
          promise.reject("ERR_NO_VIEW_CONTROLLER", "Unable to present folder picker.")
          return
        }

        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder], asCopy: false)
        picker.allowsMultipleSelection = false

        let delegate = FolderPickerDelegate { result in
          self.activePickerDelegate = nil
          switch result {
          case .cancelled:
            promise.resolve(nil)
          case .failure(let error):
            promise.reject("ERR_PICK_FOLDER", error.localizedDescription)
          case .picked(let url):
            let accessing = url.startAccessingSecurityScopedResource()
            defer {
              if accessing { url.stopAccessingSecurityScopedResource() }
            }
            do {
              let bookmark = try url.bookmarkData(
                options: .minimalBookmark,
                includingResourceValuesForKeys: nil,
                relativeTo: nil
              )
              let isICloud = url.path.contains("Mobile Documents") ||
                FileManager.default.isUbiquitousItem(at: url)
              let record = SavedFolderRecord(
                id: UUID().uuidString,
                name: url.lastPathComponent,
                bookmarkBase64: bookmark.base64EncodedString(),
                isICloud: isICloud
              )
              var all = self.loadRecords()
              all.append(record)
              self.saveRecords(all)
              promise.resolve([
                "id": record.id,
                "name": record.name,
                "isICloud": record.isICloud
              ])
            } catch {
              promise.reject("ERR_BOOKMARK", error.localizedDescription)
            }
          }
        }

        self.activePickerDelegate = delegate
        picker.delegate = delegate
        presenter.present(picker, animated: true)
      }
    }

    AsyncFunction("scanFolder") { (folderId: String) -> [[String: Any]] in
      guard let rootUrl = try self.resolveFolderUrl(folderId: folderId) else {
        throw NSError(domain: "ICloudFiles", code: 404, userInfo: [NSLocalizedDescriptionKey: "Saved folder not found"])
      }
      let accessing = rootUrl.startAccessingSecurityScopedResource()
      defer {
        if accessing { rootUrl.stopAccessingSecurityScopedResource() }
      }
      return self.scanDirectory(rootUrl: rootUrl, currentUrl: rootUrl, depth: 0)
    }

    AsyncFunction("readFile") { (folderId: String, relativePath: String) -> String in
      guard let rootUrl = try self.resolveFolderUrl(folderId: folderId) else {
        throw NSError(domain: "ICloudFiles", code: 404, userInfo: [NSLocalizedDescriptionKey: "Saved folder not found"])
      }
      let accessing = rootUrl.startAccessingSecurityScopedResource()
      defer {
        if accessing { rootUrl.stopAccessingSecurityScopedResource() }
      }
      let fileUrl = rootUrl.appendingPathComponent(relativePath)
      return try self.coordinatedReadUtf8(url: fileUrl)
    }

    AsyncFunction("readExternalUri") { (uriString: String) -> String in
      guard let url = URL(string: uriString) else {
        throw NSError(domain: "ICloudFiles", code: 400, userInfo: [NSLocalizedDescriptionKey: "Invalid file URI"])
      }
      let accessing = url.startAccessingSecurityScopedResource()
      defer {
        if accessing { url.stopAccessingSecurityScopedResource() }
      }
      return try self.coordinatedReadUtf8(url: url)
    }
  }

  private func loadRecords() -> [SavedFolderRecord] {
    guard let data = UserDefaults.standard.data(forKey: storageKey),
          let decoded = try? JSONDecoder().decode([SavedFolderRecord].self, from: data) else {
      return []
    }
    return decoded
  }

  private func saveRecords(_ records: [SavedFolderRecord]) {
    if let data = try? JSONEncoder().encode(records) {
      UserDefaults.standard.set(data, forKey: storageKey)
    }
  }

  private func resolveFolderUrl(folderId: String) throws -> URL? {
    guard let record = loadRecords().first(where: { $0.id == folderId }),
          let data = Data(base64Encoded: record.bookmarkBase64) else {
      return nil
    }
    var stale = false
    let url = try URL(
      resolvingBookmarkData: data,
      options: .withoutUI,
      relativeTo: nil,
      bookmarkDataIsStale: &stale
    )
    if stale {
      let accessing = url.startAccessingSecurityScopedResource()
      defer {
        if accessing { url.stopAccessingSecurityScopedResource() }
      }
      if let refreshed = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
        let updated = loadRecords().map {
          $0.id == folderId
            ? SavedFolderRecord(id: $0.id, name: $0.name, bookmarkBase64: refreshed.base64EncodedString(), isICloud: $0.isICloud)
            : $0
        }
        saveRecords(updated)
      }
    }
    return url
  }

  private func scanDirectory(rootUrl: URL, currentUrl: URL, depth: Int) -> [[String: Any]] {
    if depth > 6 { return [] }
    let keys: [URLResourceKey] = [
      .isDirectoryKey,
      .contentModificationDateKey,
      .fileSizeKey,
      .isUbiquitousItemKey,
      .ubiquitousItemDownloadingStatusKey,
      .ubiquitousItemIsDownloadingKey
    ]
    guard let items = try? FileManager.default.contentsOfDirectory(
      at: currentUrl,
      includingPropertiesForKeys: keys,
      options: [.skipsHiddenFiles]
    ) else {
      return []
    }

    var results: [[String: Any]] = []
    let rootPath = rootUrl.standardizedFileURL.path
    for item in items {
      let values = try? item.resourceValues(forKeys: Set(keys))
      let isDir = values?.isDirectory ?? false
      let itemPath = item.standardizedFileURL.path
      let rel = itemPath.hasPrefix(rootPath + "/")
        ? String(itemPath.dropFirst(rootPath.count + 1))
        : item.lastPathComponent

      if isDir {
        let children = scanDirectory(rootUrl: rootUrl, currentUrl: item, depth: depth + 1)
        if !children.isEmpty {
          results.append(contentsOf: children)
        }
        continue
      }

      guard item.pathExtension.lowercased() == "excalidraw" else { continue }
      let isUbiquitous = values?.isUbiquitousItem ?? false
      let dlStatus = values?.ubiquitousItemDownloadingStatus
      let downloaded = !isUbiquitous ||
        dlStatus == URLUbiquitousItemDownloadingStatus.current ||
        dlStatus == URLUbiquitousItemDownloadingStatus.downloaded
      let mtimeMs = Int((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000)

      results.append([
        "name": item.deletingPathExtension().lastPathComponent,
        "relativePath": rel,
        "size": values?.fileSize ?? 0,
        "mtime": mtimeMs,
        "isUbiquitous": isUbiquitous,
        "downloaded": downloaded,
        "downloading": values?.ubiquitousItemIsDownloading ?? false
      ])
    }
    return results
  }

  private func coordinatedReadUtf8(url: URL) throws -> String {
    if FileManager.default.isUbiquitousItem(at: url) {
      try? FileManager.default.startDownloadingUbiquitousItem(at: url)
    }

    var coordinationError: NSError?
    var readError: Error?
    var content = ""

    let coordinator = NSFileCoordinator(filePresenter: nil)
    coordinator.coordinate(readingItemAt: url, options: [], error: &coordinationError) { readUrl in
      do {
        let data = try Data(contentsOf: readUrl)
        content = String(decoding: data, as: UTF8.self)
      } catch {
        readError = error
      }
    }

    if let err = coordinationError { throw err }
    if let err = readError { throw err }
    return content
  }

  private func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let root = scenes.first(where: { $0.activationState == .foregroundActive })?.windows.first(where: { $0.isKeyWindow })?.rootViewController
      ?? scenes.first?.windows.first?.rootViewController
    var current = root
    while let presented = current?.presentedViewController {
      current = presented
    }
    return current
  }
}

private enum FolderPickResult {
  case picked(URL)
  case cancelled
  case failure(Error)
}

private final class FolderPickerDelegate: NSObject, UIDocumentPickerDelegate {
  private let completion: (FolderPickResult) -> Void

  init(completion: @escaping (FolderPickResult) -> Void) {
    self.completion = completion
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    if let first = urls.first {
      completion(.picked(first))
    } else {
      completion(.cancelled)
    }
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    completion(.cancelled)
  }
}
