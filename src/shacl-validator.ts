import * as N3 from 'n3';
import SHACLValidator from 'rdf-validate-shacl';
import type { QueryEngine } from '@comunica/query-sparql';
import { validateSparqlConstraints, resolveSparqlTargets } from './sparql-constraint-validator';
import { buildExtensionFunctions } from './shacl-functions';
import { jsonTypeAndValueToN3Term, jsonObjectToTerm } from './rdf-utils';
const { Store, Parser } = N3;

/**
 * Adapter for an external SHACL engine (e.g. Apache Jena via an HTTP
 * bridge in elm-qudt's vite dev server, or a future
 * @ralphtq/elm-rdf-jena package). Inject one via
 * `QuadStoreSession({ jenaEngine })` or by passing as the last arg to
 * the standalone validators; the validators below try Jena first then
 * fall back to the JS engine on absence or failure.
 *
 * `isAvailable()` is called once per validation; cache inside your
 * implementation if the check is expensive.
 */
export interface JenaEngine {
  isAvailable(): Promise<boolean>;
  validateGraphs(
    dataStore: N3.Store,
    shapesStore: N3.Store,
    options: { focusNodeIRI?: string; shapeIRI?: string; timeoutMs?: number }
  ): Promise<ValidationReport>;
}

interface PrefixEntry {
  prefix: string;
  iri: string;
}

interface GraphSource {
  kind: string;      // "url", "ttl", or "quads"
  content: string;   // URL string, TTL string, or JSON-encoded JSONrdfQuad array
  prefixes?: PrefixEntry[];  // CURIE prefix map (only for kind "quads")
}

interface ValidateRequest {
  dataGraphSource: GraphSource;
  shapesGraphSource: GraphSource;
  focusNode?: string;  // Optional: scope validation to a single resource IRI (CURIE expanded by caller)
}

export interface ValidationResult {
  severity: string;
  focusNode: string;
  path: string;
  sourceConstraintComponent: string;
  sourceShape: string;
  message: string;
  value: string;
}

export interface ShapeDefinition {
  shapeIRI: string;
  label: string;
  description: string;
  turtle: string;
}

export interface EngineInfo {
  engine: string;           // "jena" or "javascript"
  jenaFallback: boolean;    // true if Jena was tried and failed
  jenaError: string;        // error message from Jena (empty string if no error)
  elapsedMs: number;        // validation time in ms
}

export interface ValidationReport {
  conforms: boolean;
  results: ValidationResult[];
  shapeDefinitions: ShapeDefinition[];
  subjectsTargeted: number;
  dataSubjects: number;
  engineInfo: EngineInfo;
}

export function parseTurtleToStore(ttl: string, baseURI: string = ''): N3.Store {
  const store = new Store();
  const parser = new Parser({ baseIRI: baseURI });
  const quads = parser.parse(ttl);
  store.addQuads(quads);
  return store;
}

/**
 * Expand a CURIE (e.g. "qudt:Unit") to a full IRI using the prefix map.
 * Returns the value unchanged if it's already a full IRI or no matching prefix is found.
 */
function expandCurie(value: string, prefixMap: Record<string, string>): string {
  if (!value || value.startsWith('http://') || value.startsWith('https://') || value.startsWith('urn:')) {
    return value;
  }
  const colonIdx = value.indexOf(':');
  if (colonIdx > 0) {
    const prefix = value.substring(0, colonIdx);
    const localName = value.substring(colonIdx + 1);
    const ns = prefixMap[prefix];
    if (ns) {
      return ns + localName;
    }
  }
  return value;
}

/**
 * Expand CURIEs in a JSONrdfQuad term object in-place, returning a new object with full IRIs.
 */
function expandTermCuries(term: any, prefixMap: Record<string, string>): any {
  if (!term) return term;
  const expanded = { ...term };
  if (expanded.value) {
    expanded.value = expandCurie(expanded.value, prefixMap);
  }
  if (expanded.id) {
    expanded.id = expandCurie(expanded.id, prefixMap);
  }
  // Expand datatype CURIE if present (e.g. "xsd:string" → full IRI)
  if (expanded.datatype && expanded.datatype.value) {
    expanded.datatype = {
      ...expanded.datatype,
      value: expandCurie(expanded.datatype.value, prefixMap),
      id: expanded.datatype.id ? expandCurie(expanded.datatype.id, prefixMap) : expanded.datatype.id,
    };
  }
  return expanded;
}

/**
 * Build an N3.Store directly from a JSON-encoded array of JSONrdfQuad objects,
 * bypassing TTL serialization/parsing. Uses the same converters as rdf-writers.ts.
 * When prefixes are provided, CURIEs are expanded to full IRIs.
 */
function jsonQuadsToStore(jsonString: string, prefixes?: PrefixEntry[]): N3.Store {
  const store = new Store();
  const quads: any[] = JSON.parse(jsonString);
  const emptyPrefixes: Record<string, string> = {};

  // Build prefix map for CURIE expansion
  const prefixMap: Record<string, string> = {};
  if (prefixes) {
    for (const p of prefixes) {
      prefixMap[p.prefix] = p.iri;
    }
  }
  const hasPrefixes = Object.keys(prefixMap).length > 0;

  const n3Quads = quads.map(quad => {
    const subject = hasPrefixes ? expandTermCuries(quad.subject, prefixMap) : quad.subject;
    const predicate = hasPrefixes ? expandTermCuries(quad.predicate, prefixMap) : quad.predicate;
    const object = hasPrefixes ? expandTermCuries(quad.object, prefixMap) : quad.object;
    // Always put quads in the default graph for SHACL validation
    return N3.DataFactory.quad(
      jsonTypeAndValueToN3Term(subject, emptyPrefixes) as any,
      jsonTypeAndValueToN3Term(predicate, emptyPrefixes) as any,
      jsonObjectToTerm(object, emptyPrefixes) as any,
      N3.DataFactory.defaultGraph() as any,
    );
  });
  store.addQuads(n3Quads);
  return store;
}

async function fetchAndParse(source: GraphSource): Promise<N3.Store> {
  if (source.kind === 'url') {
    const response = await fetch(source.content);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${source.content}: ${response.status} ${response.statusText}`);
    }
    const ttl = await response.text();
    return parseTurtleToStore(ttl, source.content);
  } else if (source.kind === 'quads') {
    return jsonQuadsToStore(source.content, source.prefixes);
  } else {
    return parseTurtleToStore(source.content);
  }
}

/**
 * Create a copy of a store with all quads moved to the default graph.
 * The N3 parser stores every quad in a named graph (using baseURI), but
 * SHACL-SPARQL queries run without GRAPH clauses and only match the default graph.
 * Flattening ensures all triples are visible to both rdf-validate-shacl (Phase 1)
 * and Comunica SPARQL queries (Phase 2).
 */
function flattenToDefaultGraph(store: N3.Store): N3.Store {
  const flat = new Store();
  const dg = N3.DataFactory.defaultGraph();
  for (const quad of store.getQuads(null, null, null, null)) {
    flat.addQuad(
      quad.subject as any,
      quad.predicate as any,
      quad.object as any,
      dg as any,
    );
  }
  return flat;
}

const SH_SPARQL = 'http://www.w3.org/ns/shacl#sparql';

/**
 * Create a copy of the shapes store with sh:sparql triples removed,
 * so rdf-validate-shacl's Core validator doesn't choke on SPARQLConstraintComponent.
 */
function stripSparqlConstraints(store: N3.Store): N3.Store {
  const filtered = new Store();
  for (const quad of store.getQuads(null, null, null, null)) {
    if (quad.predicate.value !== SH_SPARQL) {
      filtered.addQuad(quad);
    }
  }
  return filtered;
}

function termToString(term: any): string {
  if (!term) return '';
  if (typeof term === 'string') return term;
  if (term.value !== undefined) return term.value;
  return String(term);
}

/**
 * Generate a human-readable message for a core SHACL validation result
 * when no explicit sh:message was provided by the shape.
 * Uses the sourceConstraintComponent IRI to describe the violation.
 */
function generateConstraintMessage(result: ValidationResult): string {
  const SH = 'http://www.w3.org/ns/shacl#';
  const component = result.sourceConstraintComponent;
  const path = result.path;
  const value = result.value;

  // Extract the local name from the component IRI
  const localName = component.includes('#')
    ? component.substring(component.lastIndexOf('#') + 1)
    : component.substring(component.lastIndexOf('/') + 1);

  // Shorten path for display
  const shortPath = path.includes('#')
    ? path.substring(path.lastIndexOf('#') + 1)
    : path.includes('/')
      ? path.substring(path.lastIndexOf('/') + 1)
      : path;

  const pathRef = shortPath ? ` for property '${shortPath}'` : '';
  const valueRef = value ? ` (got '${value.length > 80 ? value.substring(0, 77) + '...' : value}')` : '';

  switch (component) {
    case `${SH}MinCountConstraintComponent`:
      return `Missing required property${pathRef}: expected at least one value`;
    case `${SH}MaxCountConstraintComponent`:
      return `Too many values${pathRef}: exceeds maximum allowed count`;
    case `${SH}DatatypeConstraintComponent`:
      return `Invalid datatype${pathRef}${valueRef}`;
    case `${SH}ClassConstraintComponent`:
      return `Value does not have the expected class type${pathRef}${valueRef}`;
    case `${SH}NodeKindConstraintComponent`:
      return `Value has wrong node kind${pathRef}${valueRef}`;
    case `${SH}PatternConstraintComponent`:
      return `Value does not match the required pattern${pathRef}${valueRef}`;
    case `${SH}MinLengthConstraintComponent`:
      return `Value is too short${pathRef}${valueRef}`;
    case `${SH}MaxLengthConstraintComponent`:
      return `Value is too long${pathRef}${valueRef}`;
    case `${SH}MinExclusiveConstraintComponent`:
    case `${SH}MinInclusiveConstraintComponent`:
      return `Value is below the minimum${pathRef}${valueRef}`;
    case `${SH}MaxExclusiveConstraintComponent`:
    case `${SH}MaxInclusiveConstraintComponent`:
      return `Value exceeds the maximum${pathRef}${valueRef}`;
    case `${SH}InConstraintComponent`:
      return `Value is not in the allowed set${pathRef}${valueRef}`;
    case `${SH}HasValueConstraintComponent`:
      return `Required value is missing${pathRef}`;
    case `${SH}ClosedConstraintComponent`:
      return `Unexpected property found: shape is closed${pathRef}${valueRef}`;
    case `${SH}DisjointConstraintComponent`:
      return `Values must be disjoint${pathRef}${valueRef}`;
    case `${SH}EqualsConstraintComponent`:
      return `Values must be equal${pathRef}${valueRef}`;
    case `${SH}LessThanConstraintComponent`:
    case `${SH}LessThanOrEqualsConstraintComponent`:
      return `Value comparison constraint violated${pathRef}${valueRef}`;
    case `${SH}NotConstraintComponent`:
      return `Value must not match the specified shape${pathRef}${valueRef}`;
    case `${SH}AndConstraintComponent`:
      return `Value does not satisfy all required shapes${pathRef}`;
    case `${SH}OrConstraintComponent`:
      return `Value does not satisfy any of the allowed shapes${pathRef}`;
    case `${SH}XoneConstraintComponent`:
      return `Value must satisfy exactly one of the specified shapes${pathRef}`;
    case `${SH}UniqueLangConstraintComponent`:
      return `Duplicate language tag found${pathRef}${valueRef}`;
    case `${SH}QualifiedMinCountConstraintComponent`:
      return `Not enough values matching the qualified shape${pathRef}`;
    case `${SH}QualifiedMaxCountConstraintComponent`:
      return `Too many values matching the qualified shape${pathRef}`;
    case `${SH}NodeConstraintComponent`:
      return `Value does not conform to the required node shape${pathRef}${valueRef}`;
    case `${SH}SPARQLConstraintComponent`:
      return `SPARQL constraint violated${pathRef}`;
    default:
      return `Constraint '${localName}' violated${pathRef}${valueRef}`;
  }
}

/**
 * Extract Turtle definitions for the given shape IRIs from a shapes store.
 * For each shape, collects all quads where the shape is the subject and
 * serializes them as Turtle using N3.Writer.
 */
function extractShapeDefinitions(
  shapesStore: N3.Store,
  shapeIRIs: string[]
): Promise<ShapeDefinition[]> {
  const promises = shapeIRIs.map(shapeIRI => {
    return new Promise<ShapeDefinition>((resolve) => {
      const shapeNode = N3.DataFactory.namedNode(shapeIRI);
      const quads = shapesStore.getQuads(shapeNode, null, null, null);
      if (quads.length === 0) {
        resolve({ shapeIRI, label: '', description: '', turtle: '# No triples found for ' + shapeIRI });
        return;
      }

      // Extract rdfs:label and rdfs:comment for display
      const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
      const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
      const SH_SPARQL_PRED = 'http://www.w3.org/ns/shacl#sparql';
      const labelQuads = shapesStore.getQuads(shapeNode, N3.DataFactory.namedNode(RDFS_LABEL), null, null);
      const commentQuads = shapesStore.getQuads(shapeNode, N3.DataFactory.namedNode(RDFS_COMMENT), null, null);
      // Use rdfs:label if present, otherwise convert the CURIE local name to title case
      // e.g. "qudt:ConversionMultiplierSnShape" → "Conversion Multiplier Sn Shape"
      let label = '';
      if (labelQuads.length > 0) {
        label = labelQuads[0].object.value;
      } else {
        // Extract local name from IRI (after # or last /)
        let localName = shapeIRI;
        const hashIdx = shapeIRI.lastIndexOf('#');
        if (hashIdx >= 0) {
          localName = shapeIRI.substring(hashIdx + 1);
        } else {
          const slashIdx = shapeIRI.lastIndexOf('/');
          if (slashIdx >= 0) {
            localName = shapeIRI.substring(slashIdx + 1);
          }
        }
        // Convert camelCase/PascalCase to title case with spaces
        label = localName
          .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase boundaries
          .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')  // consecutive caps
          .replace(/[-_]/g, ' ')  // hyphens/underscores to spaces
          .replace(/\b\w/g, c => c.toUpperCase());  // capitalize first letter of each word
      }

      // Look for rdfs:comment on the shape itself first, then fall back to
      // rdfs:comment on the sh:sparql blank node, then "-"
      let description = '';
      if (commentQuads.length > 0) {
        description = commentQuads[0].object.value;
      } else {
        // Check sh:sparql blank nodes for rdfs:comment
        const sparqlQuads = shapesStore.getQuads(shapeNode, N3.DataFactory.namedNode(SH_SPARQL_PRED), null, null);
        for (const sq of sparqlQuads) {
          if (sq.object.termType === 'BlankNode') {
            const bnodeComments = shapesStore.getQuads(sq.object as any, N3.DataFactory.namedNode(RDFS_COMMENT), null, null);
            if (bnodeComments.length > 0) {
              description = bnodeComments[0].object.value;
              break;
            }
          }
        }
        if (!description) {
          description = '-';
        }
      }

      // Collect prefixes from the store for readable output
      const prefixes: Record<string, string> = {};
      const knownPrefixes: Record<string, string> = {
        'sh': 'http://www.w3.org/ns/shacl#',
        'xsd': 'http://www.w3.org/2001/XMLSchema#',
        'rdf': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
        'rdfs': 'http://www.w3.org/2000/01/rdf-schema#',
        'qudt': 'http://qudt.org/schema/qudt/',
        'dcterms': 'http://purl.org/dc/terms/',
        'skos': 'http://www.w3.org/2004/02/skos/core#',
        'owl': 'http://www.w3.org/2002/07/owl#',
      };
      // Only include prefixes that appear in the quads
      for (const q of quads) {
        for (const [pfx, ns] of Object.entries(knownPrefixes)) {
          if (q.subject.value.startsWith(ns) || q.predicate.value.startsWith(ns) || q.object.value.startsWith(ns)) {
            prefixes[pfx] = ns;
          }
        }
      }

      // Also collect quads for blank node objects (e.g. sh:sparql -> _:b1 -> sh:select ...)
      const allQuads = [...quads];
      const visited = new Set<string>();
      const queue = quads
        .filter(q => q.object.termType === 'BlankNode')
        .map(q => q.object.value);

      while (queue.length > 0) {
        const bnodeId = queue.pop()!;
        if (visited.has(bnodeId)) continue;
        visited.add(bnodeId);
        const bnodeQuads = shapesStore.getQuads(N3.DataFactory.blankNode(bnodeId), null, null, null);
        allQuads.push(...bnodeQuads);
        for (const bq of bnodeQuads) {
          if (bq.object.termType === 'BlankNode') {
            queue.push(bq.object.value);
          }
        }
      }

      const writer = new N3.Writer({ prefixes });
      writer.addQuads(allQuads);
      writer.end((err, result) => {
        if (err) {
          resolve({ shapeIRI, label, description, turtle: '# Error serializing shape: ' + String(err) });
        } else {
          resolve({ shapeIRI, label, description, turtle: result });
        }
      });
    });
  });
  return Promise.all(promises);
}

/**
 * Scope a shapes store to validate only a single focus node.
 * Only applies shapes whose sh:targetClass matches one of the resource's rdf:type values
 * (including transitive rdfs:subClassOf). Shapes without sh:targetClass (e.g., those using
 * sh:target with SPARQLTarget) are also included since they do their own target resolution.
 */
function scopeShapesToFocusNode(shapesStore: N3.Store, dataStore: N3.Store, focusNodeIRI: string): N3.Store {
  const SH_TARGET_CLASS = 'http://www.w3.org/ns/shacl#targetClass';
  const SH_TARGET_NODE = 'http://www.w3.org/ns/shacl#targetNode';
  const SH_TARGET = 'http://www.w3.org/ns/shacl#target';
  const SH_NODE_SHAPE = 'http://www.w3.org/ns/shacl#NodeShape';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const RDFS_SUBCLASSOF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

  // Get the focus node's rdf:type values from the data graph
  const focusNodeTypes = new Set<string>();
  const typeQuads = dataStore.getQuads(
    N3.DataFactory.namedNode(focusNodeIRI), N3.DataFactory.namedNode(RDF_TYPE), null, null
  );
  for (const tq of typeQuads) {
    focusNodeTypes.add(tq.object.value);
  }

  // Expand types with transitive rdfs:subClassOf (the focus node's types are subclasses of...)
  const expandedTypes = new Set<string>(focusNodeTypes);
  const queue = [...focusNodeTypes];
  while (queue.length > 0) {
    const cls = queue.pop()!;
    const superQuads = dataStore.getQuads(
      N3.DataFactory.namedNode(cls), N3.DataFactory.namedNode(RDFS_SUBCLASSOF), null, null
    );
    for (const sq of superQuads) {
      if (!expandedTypes.has(sq.object.value)) {
        expandedTypes.add(sq.object.value);
        queue.push(sq.object.value);
      }
    }
  }

  console.log("scopeShapesToFocusNode - focusNode:", focusNodeIRI, "types:", [...expandedTypes]);

  const scoped = new Store();

  // Determine which shapes are applicable to this focus node.
  // Two categories:
  //   retargetShapes: sh:targetClass matches focus node's types → replace with sh:targetNode
  //   sparqlTargetShapes: have sh:target (SPARQLTarget) → leave unchanged, Phase 0 resolves
  const retargetShapes = new Set<string>();
  const sparqlTargetShapes = new Set<string>();
  const nodeShapes = shapesStore.getQuads(null, N3.DataFactory.namedNode(RDF_TYPE), N3.DataFactory.namedNode(SH_NODE_SHAPE), null);

  for (const shapeQuad of nodeShapes) {
    const shapeIri = shapeQuad.subject.value;

    const targetClassQuads = shapesStore.getQuads(shapeQuad.subject, N3.DataFactory.namedNode(SH_TARGET_CLASS), null, null);
    const hasSparqlTarget = shapesStore.getQuads(shapeQuad.subject, N3.DataFactory.namedNode(SH_TARGET), null, null).length > 0;

    if (hasSparqlTarget) {
      // sh:target (SPARQLTarget) — leave unchanged, let Phase 0 resolve targets naturally.
      // The SPARQLTarget query filters focus nodes itself (e.g., by IRI prefix).
      sparqlTargetShapes.add(shapeIri);
    }

    if (targetClassQuads.length > 0) {
      // Has sh:targetClass — check if focus node's types match any of them
      for (const tcq of targetClassQuads) {
        if (expandedTypes.has(tcq.object.value)) {
          retargetShapes.add(shapeIri);
          break;
        }
      }
    }
  }

  console.log("scopeShapesToFocusNode - retarget shapes:", [...retargetShapes]);
  console.log("scopeShapesToFocusNode - sparqlTarget shapes (unchanged):", [...sparqlTargetShapes]);

  // Copy all quads, but strip sh:targetClass and sh:targetNode from retarget shapes only
  for (const quad of shapesStore.getQuads(null, null, null, null)) {
    if (quad.predicate.value === SH_TARGET_CLASS || quad.predicate.value === SH_TARGET_NODE) {
      // Keep targeting quads for sparqlTarget shapes and non-applicable shapes
      if (!retargetShapes.has(quad.subject.value)) {
        scoped.addQuad(quad);
      }
      continue;
    }
    scoped.addQuad(quad);
  }

  // Add sh:targetNode for the focus node only on retarget shapes (not sparqlTarget shapes)
  for (const shapeIri of retargetShapes) {
    scoped.addQuad(
      N3.DataFactory.namedNode(shapeIri) as any,
      N3.DataFactory.namedNode(SH_TARGET_NODE) as any,
      N3.DataFactory.namedNode(focusNodeIRI) as any,
      N3.DataFactory.defaultGraph() as any,
    );
  }

  return scoped;
}

/**
 * Pure validation function — takes parsed stores, returns a report.
 * Testable without Elm port dependencies.
 * When focusNodeIRI is provided, validation is scoped to that single resource.
 */
/**
 * Collect the set of shape IRIs owned by a given top-level shape.
 * Includes the shape itself and any property shapes linked via sh:property.
 */
function collectOwnedShapeIRIs(shapesStore: N3.Store, shapeIRI: string): Set<string> {
  const SH_PROPERTY = 'http://www.w3.org/ns/shacl#property';
  const owned = new Set<string>([shapeIRI]);
  for (const q of shapesStore.getQuads(N3.DataFactory.namedNode(shapeIRI), N3.DataFactory.namedNode(SH_PROPERTY), null, null)) {
    owned.add(q.object.value);
  }
  return owned;
}

/**
 * Build a shapes store that only contains triples for a specific shape
 * (and its property shapes), while preserving all non-shape resources
 * (prefix declarations, SPARQL functions, etc.) needed for validation.
 */
function buildScopedShapesStore(shapesStore: N3.Store, shapeIRI: string): N3.Store {
  const SH = 'http://www.w3.org/ns/shacl#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

  // Collect ALL shape IRIs in the store (to know what to exclude)
  const allShapeIRIs = new Set<string>();
  for (const shapeType of [`${SH}NodeShape`, `${SH}PropertyShape`]) {
    for (const q of shapesStore.getQuads(null, N3.DataFactory.namedNode(RDF_TYPE), N3.DataFactory.namedNode(shapeType), null)) {
      allShapeIRIs.add(q.subject.value);
    }
  }
  const shaclPredicates = ['sparql', 'targetClass', 'targetNode', 'path', 'property', 'severity', 'message'];
  for (const pred of shaclPredicates) {
    for (const q of shapesStore.getQuads(null, N3.DataFactory.namedNode(`${SH}${pred}`), null, null)) {
      if (q.subject.termType === 'NamedNode') {
        allShapeIRIs.add(q.subject.value);
      }
    }
  }

  // Collect the shape IRIs we WANT to keep
  const keptShapeIRIs = collectOwnedShapeIRIs(shapesStore, shapeIRI);

  // Shapes to exclude = all shapes minus the ones we're keeping
  const excludedShapeIRIs = new Set<string>();
  for (const iri of allShapeIRIs) {
    if (!keptShapeIRIs.has(iri)) {
      excludedShapeIRIs.add(iri);
    }
  }

  // Build a new store: keep everything except triples from excluded shapes
  const scoped = new Store();
  for (const q of shapesStore.getQuads(null, null, null, null)) {
    if (q.subject.termType === 'NamedNode' && excludedShapeIRIs.has(q.subject.value)) {
      continue; // Skip triples belonging to other shapes
    }
    scoped.addQuad(q);
  }
  return scoped;
}

export async function validateGraphs(
  dataStore: N3.Store,
  shapesStore: N3.Store,
  engine: QueryEngine,
  focusNodeIRI?: string,
  shapeIRI?: string,
  queryTimeoutMs?: number,
  jenaEngine?: JenaEngine
): Promise<ValidationReport> {
  const overallStartTime = Date.now();

  // If a Jena engine is injected and available, run validation through it.
  // On failure, log and fall through to the JS pipeline; the eventual
  // engineInfo records jenaFallback=true and jenaError=<reason>.
  let jenaFallbackReason = '';
  if (jenaEngine && (await jenaEngine.isAvailable())) {
    try {
      const report = await jenaEngine.validateGraphs(dataStore, shapesStore, {
        focusNodeIRI,
        shapeIRI,
        timeoutMs: queryTimeoutMs || 300_000,
      });
      report.engineInfo = {
        engine: 'jena',
        jenaFallback: false,
        jenaError: '',
        elapsedMs: Date.now() - overallStartTime,
      };
      return report;
    } catch (err: any) {
      jenaFallbackReason = err?.message || String(err);
      console.error('[shacl-validator] Jena validation failed, falling back to JS engine:', jenaFallbackReason);
    }
  }

  // JavaScript pipeline (Comunica + rdf-validate-shacl) — runs if no
  // Jena engine was injected, if it reported unavailable, or if it threw.

  // If scoping to a single focus node, modify the shapes store
  const effectiveShapesStore = focusNodeIRI
    ? scopeShapesToFocusNode(shapesStore, dataStore, focusNodeIRI)
    : shapesStore;

  // Build extension functions from the FULL shapes store (needs all sh:SPARQLFunction defs)
  const extensionFunctions = buildExtensionFunctions(effectiveShapesStore, dataStore, engine);

  // Phase 0: Resolve SPARQL targets → inject sh:targetNode triples
  // Uses the full shapes store so all targets are resolved correctly.

  // console.log("validateGraphs - Phase 0");

  let augmentedShapesStore = await resolveSparqlTargets(engine, dataStore, effectiveShapesStore, extensionFunctions, queryTimeoutMs);

  // When scoped to a single focus node, strip sh:targetNode triples for other resources
  // that Phase 0 may have resolved from SPARQLTarget queries against the full data graph.
  // This prevents Phase 1 and Phase 2 from validating unwanted targets.
  if (focusNodeIRI) {
    const SH_TARGET_NODE = 'http://www.w3.org/ns/shacl#targetNode';
    const filtered = new Store();
    for (const quad of augmentedShapesStore.getQuads(null, null, null, null)) {
      if (quad.predicate.value === SH_TARGET_NODE && quad.object.value !== focusNodeIRI) {
        continue; // Skip targetNode triples for other resources
      }
      filtered.addQuad(quad);
    }
    augmentedShapesStore = filtered;
  }

  // Phase 1: SHACL Core validation (with sh:sparql triples stripped)
  // When scoped to a single shape, build a store with only that shape for Phase 1.
  const phase1ShapesStore = shapeIRI
    ? buildScopedShapesStore(augmentedShapesStore, shapeIRI)
    : augmentedShapesStore;
  const coreShapesStore = stripSparqlConstraints(phase1ShapesStore);
  const validator = new SHACLValidator(coreShapesStore, {} as any);
  const report = validator.validate(dataStore);

  // console.log("validateGraphs - Phase 1, report:", report);

  const coreResults: ValidationResult[] = report.results.map((r: any) => {
    const explicitMessage = r.message && r.message.length > 0 ? termToString(r.message[0]) : '';
    const result: ValidationResult = {
      severity: termToString(r.severity),
      focusNode: termToString(r.focusNode),
      path: termToString(r.path),
      sourceConstraintComponent: termToString(r.sourceConstraintComponent),
      sourceShape: termToString(r.sourceShape),
      message: explicitMessage,
      value: termToString(r.value),
    };
    // Generate a descriptive message when the shape doesn't provide one
    if (!explicitMessage) {
      result.message = generateConstraintMessage(result);
    }
    return result;
  });

  // console.log("validateGraphs - Phase 1, results:", coreResults);

  // Phase 2: SHACL-SPARQL constraint validation (with extension functions for qfn:*)
  // Uses the full augmented shapes store so prefix declarations and functions are available.
  // When shapeIRI is set, filter constraints to only those belonging to that shape.
  const sparqlResults = await validateSparqlConstraints(engine, dataStore, augmentedShapesStore, extensionFunctions, focusNodeIRI, shapeIRI, queryTimeoutMs);

  // console.log("validateGraphs - Phase 2");

  let allResults = [...coreResults, ...sparqlResults];

  // When scoped to a single focus node, filter out results for other resources
  // (SPARQLTarget shapes may resolve additional targets from the full data graph)
  if (focusNodeIRI) {
    allResults = allResults.filter(r => r.focusNode === focusNodeIRI);
  }

  // Extract ALL shape definitions from the shapes store (NodeShape, PropertyShape, and
  // untyped shapes that use SHACL predicates like sh:sparql, sh:path, sh:targetClass)
  const SH = 'http://www.w3.org/ns/shacl#';
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const shapeIRIset = new Set<string>();

  // Collect typed shapes: sh:NodeShape and sh:PropertyShape
  for (const shapeType of [`${SH}NodeShape`, `${SH}PropertyShape`]) {
    for (const q of shapesStore.getQuads(null, N3.DataFactory.namedNode(RDF_TYPE), N3.DataFactory.namedNode(shapeType), null)) {
      shapeIRIset.add(q.subject.value);
    }
  }

  // Collect untyped shapes: subjects that use SHACL predicates but lack rdf:type
  const shaclPredicatesForDefs = ['sparql', 'targetClass', 'targetNode', 'path', 'property', 'severity', 'message'];
  for (const pred of shaclPredicatesForDefs) {
    for (const q of shapesStore.getQuads(null, N3.DataFactory.namedNode(`${SH}${pred}`), null, null)) {
      if (q.subject.termType === 'NamedNode') {
        shapeIRIset.add(q.subject.value);
      }
    }
  }

  const allShapeIRIs = [...shapeIRIset];
  const shapeDefinitions = await extractShapeDefinitions(shapesStore, allShapeIRIs);

  // Count unique targeted subjects: union of sh:targetNode objects from shapes store
  // and focusNode values from results (catches targets resolved internally by Phase 1)
  const targetedSubjects = new Set<string>();
  const SH_TARGET_NODE = `${SH}targetNode`;
  for (const q of augmentedShapesStore.getQuads(null, N3.DataFactory.namedNode(SH_TARGET_NODE), null, null)) {
    targetedSubjects.add(q.object.value);
  }
  for (const r of allResults) {
    targetedSubjects.add(r.focusNode);
  }

  // Count unique subjects in the data graph
  const dataSubjectSet = new Set<string>();
  for (const q of dataStore.getQuads(null, null, null, null)) {
    if (q.subject.termType === 'NamedNode') {
      dataSubjectSet.add(q.subject.value);
    }
  }

  return {
    conforms: report.conforms && sparqlResults.length === 0,
    results: allResults,
    shapeDefinitions,
    subjectsTargeted: targetedSubjects.size,
    dataSubjects: dataSubjectSet.size,
    engineInfo: {
      engine: 'javascript',
      jenaFallback: jenaFallbackReason !== '',
      jenaError: jenaFallbackReason,
      elapsedMs: Date.now() - overallStartTime,
    },
  };
}

export async function validateSHACL(
  request: ValidateRequest,
  engine: QueryEngine,
  jenaEngine?: JenaEngine
): Promise<ValidationReport> {
  const [dataStore, shapesStore] = await Promise.all([
    fetchAndParse(request.dataGraphSource),
    fetchAndParse(request.shapesGraphSource),
  ]);

  let expandedFocusNode: string | undefined;
  if (request.focusNode) {
    const prefixMap: Record<string, string> = {};
    if (request.dataGraphSource.prefixes) {
      for (const p of request.dataGraphSource.prefixes) {
        prefixMap[p.prefix] = p.iri;
      }
    }
    expandedFocusNode = expandCurie(request.focusNode, prefixMap);
  }

  return validateGraphs(dataStore, shapesStore, engine, expandedFocusNode, undefined, undefined, jenaEngine);
}

/**
 * Validate using the N3 quad store as the data graph.
 * This avoids sending quads from Elm and uses the full store directly,
 * ensuring all triples are available for SHACL validation.
 *
 * When focusNode is provided, validation is scoped to that single resource
 * (CURIE expanded using the store's prefix objects).
 * When focusNode is null/undefined, validates all resources (full QA run).
 */
/**
 * Schema QA validation: extract SHACL shapes from the N3 store itself and validate
 * the full store against those shapes. This tests the data against schema constraints
 * that are part of the ontology (e.g., NodeShape/PropertyShape definitions imported
 * alongside the data).
 *
 * The shapes are extracted by finding all triples whose subjects are typed as
 * sh:NodeShape or sh:PropertyShape, plus any supporting triples (blank nodes,
 * property shapes, etc.). The full store (flattened to default graph) serves as
 * both the source of shapes and the data graph.
 */
export async function validateSchemaQA(
  request: { queryTimeoutMs: number; focusGraphId: string | null; importedGraphIds: string[] },
  dataStore: N3.Store,
  prefixObjects: Array<{ prefix: string; iri: string }>,
  engine: QueryEngine,
  jenaEngine?: JenaEngine
): Promise<ValidationReport> {
  const SH = 'http://www.w3.org/ns/shacl#';
    const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

    // Extract all SHACL shape triples from the store into a separate shapes store
    const shapesStore = new Store();

    // Collect shape subject IRIs (NodeShape and PropertyShape)
    const shapeSubjects = new Set<string>();
    for (const shapeType of [`${SH}NodeShape`, `${SH}PropertyShape`]) {
      for (const q of dataStore.getQuads(null, N3.DataFactory.namedNode(RDF_TYPE), N3.DataFactory.namedNode(shapeType), null)) {
        shapeSubjects.add(q.subject.value);
      }
    }

    // Also find subjects that use SHACL predicates (untyped shapes)
    const shaclPredicates = ['sparql', 'targetClass', 'targetNode', 'path', 'property',
                             'severity', 'message', 'minCount', 'maxCount', 'datatype',
                             'class', 'nodeKind', 'pattern', 'select', 'prefixes',
                             'SPARQLFunction', 'target'];
    for (const pred of shaclPredicates) {
      for (const q of dataStore.getQuads(null, N3.DataFactory.namedNode(`${SH}${pred}`), null, null)) {
        if (q.subject.termType === 'NamedNode') {
          shapeSubjects.add(q.subject.value);
        }
      }
    }

    console.log("validateSchemaQA - found", shapeSubjects.size, "shape subjects in store");

    if (shapeSubjects.size === 0) {
      // No shapes found — return empty report
      const emptyReport: ValidationReport = {
        conforms: true,
        results: [],
        shapeDefinitions: [],
        subjectsTargeted: 0,
        dataSubjects: 0,
        engineInfo: { engine: 'none', jenaFallback: false, jenaError: 'No SHACL shapes found in store', elapsedMs: 0 },
      };
      return emptyReport;
    }

    // Predicates whose named-node objects should also be traversed into the shapes store.
    // This includes SHACL shape-referencing predicates and RDF list predicates
    // (sh:or/sh:and/sh:xone point to RDF lists whose rdf:first elements are shape IRIs).
    const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
    const followNamedNodePredicates = new Set([
      `${SH}or`, `${SH}and`, `${SH}not`, `${SH}xone`,
      `${SH}node`, `${SH}property`, `${SH}qualifiedValueShape`,
      `${RDF}first`, `${RDF}rest`,
    ]);

    // Copy all triples for shape subjects (and their descendants) into shapesStore.
    // Follow blank node objects always, and also follow named node objects when
    // the predicate is a shape-referencing predicate (sh:or, sh:and, sh:node, etc.)
    const visited = new Set<string>();
    const queue: string[] = [...shapeSubjects];

    while (queue.length > 0) {
      const subjectId = queue.pop()!;
      if (visited.has(subjectId)) continue;
      visited.add(subjectId);

      const isBlank = subjectId.startsWith('_:') || !subjectId.includes('://');
      const subjectTerm = isBlank
        ? N3.DataFactory.blankNode(subjectId)
        : N3.DataFactory.namedNode(subjectId);

      const quads = dataStore.getQuads(subjectTerm, null, null, null);
      for (const q of quads) {
        shapesStore.addQuad(
          q.subject as any,
          q.predicate as any,
          q.object as any,
          N3.DataFactory.defaultGraph() as any,
        );
        // Always follow blank node objects to capture nested structure (RDF lists, etc.)
        if (q.object.termType === 'BlankNode') {
          queue.push(q.object.value);
        }
        // Also follow named node objects for shape-referencing and RDF list predicates
        if (q.object.termType === 'NamedNode' && followNamedNodePredicates.has(q.predicate.value)) {
          queue.push(q.object.value);
        }
      }
    }

    console.log("validateSchemaQA - shapes store has", shapesStore.size, "quads");

    // Build data store from focus graph and its imported graphs (or flatten all if no focus graph)
    const flatDataStore = new Store();
    const dg = N3.DataFactory.defaultGraph();
    if (request.focusGraphId) {
      // Collect quads from the focus graph and all imported graphs
      const graphIds = [request.focusGraphId, ...request.importedGraphIds];
      console.log("validateSchemaQA - data graphs:", graphIds);
      for (const graphId of graphIds) {
        const graphNode = N3.DataFactory.namedNode(graphId);
        for (const quad of dataStore.getQuads(null, null, null, graphNode)) {
          flatDataStore.addQuad(
            quad.subject as any,
            quad.predicate as any,
            quad.object as any,
            dg as any,
          );
        }
      }
      console.log("validateSchemaQA - data store scoped to focus graph + " + request.importedGraphIds.length + " imported graphs, total", flatDataStore.size, "quads");

    } else {
      // Fallback: flatten entire store
      for (const quad of dataStore.getQuads(null, null, null, null)) {
        flatDataStore.addQuad(
          quad.subject as any,
          quad.predicate as any,
          quad.object as any,
          dg as any,
        );
      }
      console.log("validateSchemaQA - no focus graph, using all", flatDataStore.size, "quads");
    }

    const validationReport = await validateGraphs(
      flatDataStore,
      shapesStore,
      engine,
      undefined,       // no focus node — validate all
      undefined,       // no single shape — validate all shapes
      request.queryTimeoutMs,
      jenaEngine
    );

    return validationReport;
}

export async function validateSHACLwithStore(
  request: { focusNode: string | null; shapesGraphKind: string; shapesGraphContent: string; shapeIRI: string | null; loadOnly: boolean; queryTimeoutMs: number },
  dataStore: N3.Store,
  prefixObjects: Array<{ prefix: string; iri: string }>,
  engine: QueryEngine,
  jenaEngine?: JenaEngine
): Promise<ValidationReport> {
  const shapesStore = await fetchAndParse({
      kind: request.shapesGraphKind,
      content: request.shapesGraphContent,
    });

    // loadOnly mode: just extract shape definitions, skip validation
    if (request.loadOnly) {
      console.log("validateSHACLwithStore - loadOnly mode, extracting shape definitions");

      const SH = 'http://www.w3.org/ns/shacl#';
      const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
      const shapeIRIset = new Set<string>();

      for (const shapeType of [`${SH}NodeShape`, `${SH}PropertyShape`]) {
        for (const q of shapesStore.getQuads(null, N3.DataFactory.namedNode(RDF_TYPE), N3.DataFactory.namedNode(shapeType), null)) {
          shapeIRIset.add(q.subject.value);
        }
      }

      const shaclPredicates = ['sparql', 'targetClass', 'targetNode', 'path', 'property', 'severity', 'message'];
      for (const pred of shaclPredicates) {
        for (const q of shapesStore.getQuads(null, N3.DataFactory.namedNode(`${SH}${pred}`), null, null)) {
          if (q.subject.termType === 'NamedNode') {
            shapeIRIset.add(q.subject.value);
          }
        }
      }

      const allShapeIRIs = [...shapeIRIset];
      const shapeDefinitions = await extractShapeDefinitions(shapesStore, allShapeIRIs);

      const report: ValidationReport = {
        conforms: true,
        results: [],
        shapeDefinitions,
        subjectsTargeted: 0,
        dataSubjects: 0,
        engineInfo: { engine: 'none', jenaFallback: false, jenaError: '', elapsedMs: 0 },
      };

      return report;
    }

    // Build prefix map for CURIE expansion
    const prefixMap: Record<string, string> = {};
    for (const p of prefixObjects) {
      prefixMap[p.prefix] = p.iri;
    }

    // Expand focusNode CURIE to full IRI if provided
    let expandedFocusNode: string | undefined;
    if (request.focusNode) {
      expandedFocusNode = expandCurie(request.focusNode, prefixMap);
      console.log("validateSHACLwithStore - focusNode:", request.focusNode, "->", expandedFocusNode);
    } else {
      console.log("validateSHACLwithStore - full QA validation (no focus node)");
    }

    // Expand shapeIRI CURIE to full IRI if provided
    let expandedShapeIRI: string | undefined;
    if (request.shapeIRI) {
      expandedShapeIRI = expandCurie(request.shapeIRI, prefixMap);
      console.log("validateSHACLwithStore - scoped to shape:", request.shapeIRI, "->", expandedShapeIRI);
    }

    // Flatten all named-graph quads to the default graph so that SHACL-SPARQL
    // queries (which have no GRAPH clause) can find all triples.
    const flatDataStore = flattenToDefaultGraph(dataStore);

    const validationReport = await validateGraphs(
      flatDataStore,
      shapesStore,
      engine,
      expandedFocusNode,
      expandedShapeIRI,
      request.queryTimeoutMs,
      jenaEngine
    );

    return validationReport;
}
