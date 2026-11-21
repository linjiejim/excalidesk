import { requireOptionalNativeModule } from "expo-modules-core";

export interface SavedICloudFolder {
  id: string;
  name: string;
  isICloud: boolean;
}

export interface ScannedICloudFile {
  name: string;
  relativePath: string;
  size: number;
  mtime: number;
  isUbiquitous: boolean;
  downloaded: boolean;
  downloading: boolean;
}

interface NativeICloudFilesModule {
  isICloudAvailable(): boolean;
  listSavedFolders(): SavedICloudFolder[];
  removeSavedFolder(folderId: string): boolean;
  pickFolder(): Promise<SavedICloudFolder | null>;
  scanFolder(folderId: string): Promise<ScannedICloudFile[]>;
  readFile(folderId: string, relativePath: string): Promise<string>;
  readExternalUri(uri: string): Promise<string>;
}

const Native = requireOptionalNativeModule<NativeICloudFilesModule>("ICloudFiles");

export const isNativeICloudModuleAvailable = Native !== null;

export function isICloudSignedIn(): boolean {
  return Native ? Native.isICloudAvailable() : false;
}

export function listSavedFolders(): SavedICloudFolder[] {
  return Native ? Native.listSavedFolders() : [];
}

export function removeSavedFolder(folderId: string): boolean {
  return Native ? Native.removeSavedFolder(folderId) : false;
}

export async function pickICloudFolder(): Promise<SavedICloudFolder | null> {
  if (!Native) return null;
  return Native.pickFolder();
}

export async function scanICloudFolder(folderId: string): Promise<ScannedICloudFile[]> {
  if (!Native) return [];
  return Native.scanFolder(folderId);
}

export async function readICloudFile(folderId: string, relativePath: string): Promise<string> {
  if (!Native) throw new Error("Native ICloudFiles module is unavailable in Expo Go. Build with `npx expo run:ios` or EAS Build.");
  return Native.readFile(folderId, relativePath);
}

export async function readExternalICloudUri(uri: string): Promise<string> {
  if (!Native) throw new Error("Native ICloudFiles module is unavailable");
  return Native.readExternalUri(uri);
}
