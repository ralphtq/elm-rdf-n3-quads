import { QueryEngine } from '@comunica/query-sparql';
import {
  ParseState,
  ParseResult,
  makeEmptyParseState,
  parseN3,
} from './n3-parser';
import {
  QueryResultJSONdataModel,
  queryN3,
  queryN3Tabular,
} from './n3-query';
import { queryInScopeSchemaResources } from './schema-resources-query';
import { writeQuads, writeJSONLD } from './rdf-writers';
import {
  formatSPARQL,
  formatQueryKindSPARQL,
  QueryKindSPARQLResponse,
} from './sparql-format';
import {
  parseShapeCollection,
  ShapeCollectionJSON,
} from './shape-parser';
import {
  catalogZipFromDataUrl,
  getZipContent,
  getZipContentWithBase,
  clearZipCache,
  ZipCatalogEntry,
} from './zip-catalog';
import {
  validateSHACL,
  validateSchemaQA,
  validateSHACLwithStore,
  ValidationReport,
  JenaEngine,
} from './shacl-validator';

/**
 * Options for a new QuadStoreSession.
 */
export type QuadStoreSessionOptions = {
  /** Inject a Comunica QueryEngine. Defaults to `new QueryEngine()`. */
  engine?: QueryEngine;
  /** Inject an existing ParseState. Defaults to a fresh empty store. */
  state?: ParseState;
  /**
   * Optional Apache Jena SHACL engine. When provided, every validate*
   * call tries Jena first and falls back to the JS pipeline on failure.
   * Leave unset to use the JS engine only.
   */
  jenaEngine?: JenaEngine;
};

/**
 * High-level façade over the package modules. Owns the N3.Store and
 * Comunica QueryEngine singletons that previously lived as closure
 * variables in elm-qudt's index.ts.
 *
 * Every method returns a Promise. There is no Elm port awareness — a
 * companion package (`@ralphtq/rdf-quadstore-elm-ports`) wires these
 * methods to elm-pages ports.
 *
 * Example:
 *
 * ```ts
 * const session = new QuadStoreSession();
 * const { numberOfQuads } = await session.parseTTL(ttl, baseURI);
 * const results = await session.query('SELECT ?s WHERE { ?s ?p ?o }');
 * ```
 */
export class QuadStoreSession {
  readonly engine: QueryEngine;
  readonly state: ParseState;
  readonly jenaEngine?: JenaEngine;

  constructor(options: QuadStoreSessionOptions = {}) {
    this.engine = options.engine ?? new QueryEngine();
    this.state = options.state ?? makeEmptyParseState();
    this.jenaEngine = options.jenaEngine;
  }

  /**
   * Parse TTL/N3 content into the session's quad store.
   *
   * @param ttl              The Turtle / N3 content to parse.
   * @param baseURI          Graph IRI to assign to every parsed triple.
   * @param initializeStore  When true, discard the existing store and
   *                         prefixes before parsing.
   */
  parseTTL(ttl: string, baseURI: string, initializeStore = false): Promise<ParseResult> {
    return parseN3(this.state, initializeStore, baseURI, ttl);
  }

  /** Reset the in-memory N3.Store, prefixes, and quad count to empty. */
  clearStore(): void {
    const fresh = makeEmptyParseState();
    this.state.quadStore = fresh.quadStore;
    this.state.prefixObjects = fresh.prefixObjects;
    this.state.currentBaseURI = fresh.currentBaseURI;
    this.state.currentQuadsCount = fresh.currentQuadsCount;
    this.state.quads = fresh.quads;
    clearZipCache();
  }

  /**
   * Run a SPARQL query against the session's store and return the
   * elm-qudt JSONrdfQuad wire shape.
   */
  query(sparql: string): Promise<QueryResultJSONdataModel> {
    return queryN3(this.engine, this.state, sparql);
  }

  /**
   * Run a SPARQL SELECT and return standard SPARQL JSON results
   * (https://www.w3.org/TR/sparql11-results-json/) as a string.
   */
  queryTabular(sparql: string): Promise<string> {
    return queryN3Tabular(this.engine, this.state, sparql);
  }

  /** Direct N3.Store traversal for in-scope schema resources. */
  querySchemaResources(typeIRIs: string[]): QueryResultJSONdataModel {
    return queryInScopeSchemaResources(this.state, typeIRIs);
  }

  /** Serialize an array of JSONrdfQuad objects to TriG. */
  writeTurtle(quads: any[]): Promise<string> {
    return writeQuads(this.state.prefixObjects, quads);
  }

  /** Serialize an array of JSONrdfQuad objects to compacted JSON-LD. */
  writeJSONLD(quads: any[]): Promise<string> {
    return writeJSONLD(this.state.prefixObjects, quads);
  }

  /** Pretty-print a SPARQL query string. */
  formatSPARQL(sparql: string): Promise<string> {
    return formatSPARQL(this.state.prefixObjects, sparql);
  }

  /** Pretty-print a SPARQL query and tag it with a graphId / query-kind key. */
  formatQueryKindSPARQL(
    graphId: string,
    graphQueryKindKey: string,
    sparql: string
  ): Promise<QueryKindSPARQLResponse> {
    return formatQueryKindSPARQL(this.state.prefixObjects, graphId, graphQueryKindKey, sparql);
  }

  /** Parse a SHACL shape-collection TTL file. */
  parseShapeCollection(filePath: string): Promise<ShapeCollectionJSON> {
    return parseShapeCollection(filePath, this.state.prefixObjects);
  }

  /** Catalog a ZIP file from a base64 data URL. */
  catalogZip(dataUrl: string): Promise<ZipCatalogEntry[]> {
    return catalogZipFromDataUrl(dataUrl);
  }

  /** Look up cached ZIP content (post-catalogZip). */
  getZipContent(zipPath: string): string | undefined {
    return getZipContent(zipPath);
  }

  /** Look up cached ZIP content with its extracted base URI. */
  getZipContentWithBase(
    zipPath: string
  ): { content: string; baseURI: string } | undefined {
    return getZipContentWithBase(zipPath);
  }

  /**
   * Run SHACL validation against a data graph and a shapes graph,
   * each provided as a TTL string, URL, or JSON quads payload.
   */
  validateSHACL(
    request: Parameters<typeof validateSHACL>[0]
  ): Promise<ValidationReport> {
    return validateSHACL(request, this.engine, this.jenaEngine);
  }

  /**
   * Extract SHACL shapes from the session's store and validate the
   * store against them.
   */
  validateSchemaQA(
    request: { queryTimeoutMs: number; focusGraphId: string | null; importedGraphIds: string[] }
  ): Promise<ValidationReport> {
    return validateSchemaQA(
      request,
      this.state.quadStore,
      this.state.prefixObjects,
      this.engine,
      this.jenaEngine
    );
  }

  /**
   * Validate the session's store against an external shapes graph.
   */
  validateSHACLwithStore(
    request: {
      focusNode: string | null;
      shapesGraphKind: string;
      shapesGraphContent: string;
      shapeIRI: string | null;
      loadOnly: boolean;
      queryTimeoutMs: number;
    }
  ): Promise<ValidationReport> {
    return validateSHACLwithStore(
      request,
      this.state.quadStore,
      this.state.prefixObjects,
      this.engine,
      this.jenaEngine
    );
  }
}
