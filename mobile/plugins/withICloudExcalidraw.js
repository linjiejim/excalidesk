const { withEntitlementsPlist, withInfoPlist } = require("@expo/config-plugins");

/**
 * Expo Config Plugin for Excalidesk iOS:
 * 1. Adds iCloud Documents entitlements so the app can read/sync its iCloud container & iCloud Drive folders.
 * 2. Registers `.excalidraw` file type (UTI) and enables opening `.excalidraw` files in-place from iOS Files / iCloud Drive.
 */
function withICloudExcalidraw(config, options = {}) {
  const containerId = options.containerId || "iCloud.dev.jim.excalidesk";
  const containerName = options.containerName || "Excalidesk";

  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults["com.apple.developer.icloud-services"] = ["CloudDocuments"];
    cfg.modResults["com.apple.developer.icloud-container-identifiers"] = [containerId];
    cfg.modResults["com.apple.developer.ubiquity-container-identifiers"] = [containerId];
    return cfg;
  });

  config = withInfoPlist(config, (cfg) => {
    cfg.modResults.LSSupportsOpeningDocumentsInPlace = true;
    cfg.modResults.UIFileSharingEnabled = true;

    cfg.modResults.NSUbiquitousContainers = {
      ...(cfg.modResults.NSUbiquitousContainers || {}),
      [containerId]: {
        NSUbiquitousContainerIsDocumentScopePublic: true,
        NSUbiquitousContainerSupportedFolderLevels: "Any",
        NSUbiquitousContainerName: containerName,
      },
    };

    const existingTypes = Array.isArray(cfg.modResults.CFBundleDocumentTypes)
      ? cfg.modResults.CFBundleDocumentTypes.filter((t) => t.CFBundleTypeName !== "Excalidraw Drawing")
      : [];

    cfg.modResults.CFBundleDocumentTypes = [
      ...existingTypes,
      {
        CFBundleTypeName: "Excalidraw Drawing",
        LSHandlerRank: "Alternate",
        LSItemContentTypes: ["dev.excalidraw.drawing"],
      },
    ];

    const existingUTIs = Array.isArray(cfg.modResults.UTImportedTypeDeclarations)
      ? cfg.modResults.UTImportedTypeDeclarations.filter((u) => u.UTTypeIdentifier !== "dev.excalidraw.drawing")
      : [];

    cfg.modResults.UTImportedTypeDeclarations = [
      ...existingUTIs,
      {
        UTTypeIdentifier: "dev.excalidraw.drawing",
        UTTypeDescription: "Excalidraw Drawing",
        UTTypeConformsTo: ["public.json", "public.data", "public.content"],
        UTTypeTagSpecification: {
          "public.filename-extension": ["excalidraw"],
          "public.mime-type": ["application/vnd.excalidraw+json"],
        },
      },
    ];

    return cfg;
  });

  return config;
}

module.exports = withICloudExcalidraw;
