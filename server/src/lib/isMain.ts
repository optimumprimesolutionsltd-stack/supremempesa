import { pathToFileURL } from 'node:url';

/** True when the module at `metaUrl` is the entrypoint node was started with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(entry).href;
}
