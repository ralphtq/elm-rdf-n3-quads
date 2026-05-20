import JSZip from 'jszip';

const zipContentCache = new Map<string, string>();

export type ZipCatalogEntry = {
  path: string;
  fileName: string;
  isDirectory: boolean;
  sizeBytes: number;
  baseURI: string;
};

/**
 * Extract a ZIP file from a base64 data URL and build a catalog of
 * entries. TTL file contents are cached in memory for subsequent
 * import via getZipContent / getZipContentWithBase.
 *
 * No `app` parameter; returns a Promise. Throws on errors.
 */
export async function catalogZipFromDataUrl(dataUrl: string): Promise<ZipCatalogEntry[]> {
  const base64 = dataUrl.split(',')[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  const zip = await JSZip.loadAsync(bytes);
  const entries: ZipCatalogEntry[] = [];

  zipContentCache.clear();

  const directories = new Set<string>();

  for (const [path, zipObj] of Object.entries(zip.files)) {
    const file = zipObj as any;
    if (file.dir) {
      directories.add(path);
      entries.push({
        path,
        fileName: path.split('/').filter(Boolean).pop() || path,
        isDirectory: true,
        sizeBytes: 0,
        baseURI: '',
      });
      continue;
    }

    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dirPath = parts.slice(0, i).join('/') + '/';
      if (!directories.has(dirPath)) {
        directories.add(dirPath);
        entries.push({
          path: dirPath,
          fileName: parts[i - 1],
          isDirectory: true,
          sizeBytes: 0,
          baseURI: '',
        });
      }
    }

    const isTtl = /\.(ttl|n3|rdf)$/i.test(path);
    let sizeBytes = 0;
    let entryBaseURI = '';

    if (isTtl) {
      const content = await file.async('string');
      zipContentCache.set(path, content);
      sizeBytes = content.length;
      const rawURI = extractBaseURI(content);
      entryBaseURI = rawURI.startsWith('http://')
        ? rawURI.replace('http://', 'https://')
        : rawURI;
    } else {
      const data = await file.async('uint8array');
      sizeBytes = data.length;
    }

    entries.push({
      path,
      fileName: path.split('/').pop() || path,
      isDirectory: false,
      sizeBytes,
      baseURI: entryBaseURI,
    });
  }

  return entries;
}

export function getZipContent(zipPath: string): string | undefined {
  return zipContentCache.get(zipPath);
}

/**
 * Three-tier base URI extraction from TTL content:
 *   1. @base <URI> . or BASE <URI> directive
 *   2. owl:Ontology subject — find a line with owl:Ontology, search
 *      backwards for a <URI> on a preceding line
 *   3. Fall back to empty string (default graph)
 */
function extractBaseURI(ttl: string): string {
  const baseMatch = ttl.match(/@base\s+<([^>]+)>/i) || ttl.match(/BASE\s+<([^>]+)>/i);
  if (baseMatch) return baseMatch[1];

  const lines = ttl.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/owl:Ontology/.test(lines[i])) {
      for (let j = i; j >= 0; j--) {
        const uriMatch = lines[j].match(/^<([^>]+)>/);
        if (uriMatch) return uriMatch[1];
      }
      break;
    }
  }

  return '';
}

export function getZipContentWithBase(
  zipPath: string
): { content: string; baseURI: string } | undefined {
  const content = zipContentCache.get(zipPath);
  if (!content) return undefined;
  const rawBaseURI = extractBaseURI(content);
  const baseURI = rawBaseURI.startsWith('http://')
    ? rawBaseURI.replace('http://', 'https://')
    : rawBaseURI;
  return { content, baseURI };
}

export function clearZipCache(): void {
  zipContentCache.clear();
}
