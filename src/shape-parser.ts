import * as N3 from 'n3';
import { shortenIri } from './rdf-utils';

const { namedNode } = N3.DataFactory;

// Namespace IRIs
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first';
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const SH_NODE_SHAPE = 'http://www.w3.org/ns/shacl#NodeShape';
const SH_SPARQL_FUNCTION = 'http://www.w3.org/ns/shacl#SPARQLFunction';
const SH_DECLARE = 'http://www.w3.org/ns/shacl#declare';
const SH_SPARQL = 'http://www.w3.org/ns/shacl#sparql';

export interface ShapeEntryJSON {
  key: string;
  name: string;
  description: string;
  shapeTTL: string;
}

export interface PrefixEntryJSON {
  prefix: string;
  iri: string;
}

export interface ShapeCollectionJSON {
  shapes: ShapeEntryJSON[];
  commonShapes: ShapeEntryJSON[];
  prefixes: PrefixEntryJSON[];
}

/**
 * Extract the local name from an IRI (everything after the last / or #).
 */
function localName(iri: string): string {
  const hashIdx = iri.lastIndexOf('#');
  const slashIdx = iri.lastIndexOf('/');
  const idx = Math.max(hashIdx, slashIdx);
  return idx >= 0 ? iri.slice(idx + 1) : iri;
}

/**
 * Get the first object value for a given subject+predicate from the store.
 */
function getObjectValue(store: N3.Store, subject: N3.Term, predicateIRI: string): string | null {
  const quads = store.getQuads(subject, namedNode(predicateIRI), null, null);
  return quads.length > 0 ? quads[0].object.value : null;
}

/**
 * Collect all quads for a subject, recursively following blank node objects.
 * This captures nested structures like sh:sparql [ ... ], sh:parameter [ ... ],
 * and RDF lists (rdf:first/rdf:rest).
 */
function collectSubjectQuads(store: N3.Store, subject: N3.Term, visited: Set<string>): N3.Quad[] {
  const key = subject.termType + ':' + subject.value;
  if (visited.has(key)) return [];
  visited.add(key);

  const quads = store.getQuads(subject, null, null, null);
  const result: N3.Quad[] = [...quads];

  for (const q of quads) {
    if (q.object.termType === 'BlankNode') {
      result.push(...collectSubjectQuads(store, q.object, visited));
    }
  }

  return result;
}

/**
 * Serialize a subject's quads to Turtle, stripping @prefix lines.
 * The prefixes are handled separately during reassembly.
 */
function serializeSubjectToTurtle(
  subject: N3.Term,
  store: N3.Store,
  prefixes: Record<string, string>
): Promise<string> {
  return new Promise((resolve, reject) => {
    const visited = new Set<string>();
    const quads = collectSubjectQuads(store, subject, visited);

    if (quads.length === 0) {
      resolve('');
      return;
    }

    const writer = new N3.Writer({ prefixes });
    writer.addQuads(quads);
    writer.end((error, result) => {
      if (error) {
        reject(error);
      } else {
        // Strip @prefix lines — they are handled separately during reassembly
        const lines = result.split('\n');
        const nonPrefixLines = lines.filter(
          (line: string) => !line.trim().startsWith('@prefix')
        );
        resolve(nonPrefixLines.join('\n').trim());
      }
    });
  });
}

/**
 * Build a ShapeEntryJSON for a given subject.
 */
async function buildEntry(
  subject: N3.Term,
  store: N3.Store,
  prefixes: Record<string, string>
): Promise<ShapeEntryJSON> {
  const key = shortenIri(subject.value, prefixes);
  const name = getObjectValue(store, subject, RDFS_LABEL) ?? localName(subject.value);
  let description = getObjectValue(store, subject, RDFS_COMMENT) ?? '';

  // If no description on the shape itself, check sh:sparql blank node's rdfs:comment
  if (!description) {
    const sparqlBNodes = store.getQuads(subject, namedNode(SH_SPARQL), null, null);
    for (const q of sparqlBNodes) {
      const bNodeComments = store.getQuads(q.object, namedNode(RDFS_COMMENT), null, null);
      if (bNodeComments.length > 0) {
        description = bNodeComments[0].object.value;
        break;
      }
    }
  }

  const shapeTTL = await serializeSubjectToTurtle(subject, store, prefixes);
  return { key, name, description, shapeTTL };
}

/**
 * Parse a TTL file and extract a ShapeCollectionJSON structure.
 */
export async function parseShapeCollection(
  filePath: string,
  existingPrefixObjects?: Array<{ prefix: string; iri: string }>
): Promise<ShapeCollectionJSON> {
  // Fetch the TTL file
  const response = await fetch(filePath);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${filePath}: ${response.status} ${response.statusText}`);
  }
  const ttlContent = await response.text();

  // Parse with N3.js
  const store = new N3.Store();
  let parsedPrefixes: Record<string, string> = {};

  await new Promise<void>((resolve, reject) => {
    const parser = new N3.Parser();
    parser.parse(ttlContent, (error, quad, maybePrefixes) => {
      if (error) {
        reject(error);
      } else if (quad) {
        store.addQuad(quad);
      } else {
        parsedPrefixes = maybePrefixes as unknown as Record<string, string>;
        resolve();
      }
    });
  });

  // Build prefix entries
  const prefixEntries: PrefixEntryJSON[] = Object.entries(parsedPrefixes)
    .filter(([prefix, _]) => prefix !== '') // Skip the empty/default prefix
    .map(([prefix, iri]) => ({ prefix, iri: iri as string }));

  // Build a prefixes Record for shortenIri
  const prefixRecord: Record<string, string> = {};
  for (const entry of prefixEntries) {
    prefixRecord[entry.prefix] = entry.iri;
  }

  // Also include existing app prefixes for more complete CURIE generation
  if (existingPrefixObjects) {
    for (const po of existingPrefixObjects) {
      if (!prefixRecord[po.prefix]) {
        prefixRecord[po.prefix] = po.iri;
      }
    }
  }

  // Extract common shapes (functions and allPrefixes resource)
  const commonEntries: ShapeEntryJSON[] = [];

  // Find allPrefixes resource (subjects with sh:declare triples)
  const declareSubjects = new Set<string>();
  for (const q of store.getQuads(null, namedNode(SH_DECLARE), null, null)) {
    declareSubjects.add(q.subject.value);
  }
  for (const subjectValue of Array.from(declareSubjects)) {
    const subject = namedNode(subjectValue);
    const entry = await buildEntry(subject, store, prefixRecord);
    commonEntries.push(entry);
  }

  // Find SHACL functions (sh:SPARQLFunction)
  const functionSubjects = store.getQuads(null, namedNode(RDF_TYPE), namedNode(SH_SPARQL_FUNCTION), null);
  for (const q of functionSubjects) {
    const entry = await buildEntry(q.subject, store, prefixRecord);
    commonEntries.push(entry);
  }

  // Extract shapes (sh:NodeShape)
  const shapeSubjects = store.getQuads(null, namedNode(RDF_TYPE), namedNode(SH_NODE_SHAPE), null);
  const shapeEntries: ShapeEntryJSON[] = [];
  for (const q of shapeSubjects) {
    const entry = await buildEntry(q.subject, store, prefixRecord);
    shapeEntries.push(entry);
  }

  // Sort entries by key for consistent ordering
  shapeEntries.sort((a, b) => a.key.localeCompare(b.key));
  commonEntries.sort((a, b) => a.key.localeCompare(b.key));

  return {
    shapes: shapeEntries,
    commonShapes: commonEntries,
    prefixes: prefixEntries,
  };
}
