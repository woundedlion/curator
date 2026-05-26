import {
  AUDIO_EXTENSIONS,
  PLAYLIST_EXTENSIONS,
  TEXT_EXTENSIONS,
} from "../constants";

export function getExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1) return "";
  return fileName.slice(dot + 1).toLowerCase();
}

export function isAudioFile(fileName: string): boolean {
  return (AUDIO_EXTENSIONS as readonly string[]).includes(getExtension(fileName));
}

export function isTextFile(fileName: string): boolean {
  return (TEXT_EXTENSIONS as readonly string[]).includes(getExtension(fileName));
}

export function isPlaylistFile(fileName: string): boolean {
  return (PLAYLIST_EXTENSIONS as readonly string[]).includes(
    getExtension(fileName),
  );
}

export function isIngestibleFile(fileName: string): boolean {
  return isAudioFile(fileName) || isTextFile(fileName) || isPlaylistFile(fileName);
}
