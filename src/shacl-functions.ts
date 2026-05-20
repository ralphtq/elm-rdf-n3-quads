/**
 * SHACL SPARQL Function support for QUDT QA validation.
 *
 * Implements:
 * - sh:SPARQLFunction definitions (query-based custom functions parsed from shapes graph)
 * - Native helper functions in the qfn: namespace (dimVec.pow, dimVec.multiply, bound, localname)
 *
 * These are registered as Comunica extension functions so SPARQL queries
 * containing qfn:* calls can execute correctly.
 */

import * as N3 from 'n3';
import type { QueryEngine } from '@comunica/query-sparql';
import type * as RDF from '@rdfjs/types';

const SH = 'http://www.w3.org/ns/shacl#';
const QFN = 'http://qudt.org/shacl/functions#';
const QKDV = 'http://qudt.org/vocab/dimensionvector/';

// ─── Dimension Vector Utilities ──────────────────────────────────────────────
//
// QUDT dimension vectors are IRIs like:
//   http://qudt.org/vocab/dimensionvector/A0E1L0I0M0H0T-2D0
//
// The local name encodes 8 dimension codes (A, E, L, I, M, H, T, D) each
// followed by an integer exponent (possibly negative).

const DIM_CODES = ['A', 'E', 'L', 'I', 'M', 'H', 'T', 'D'];

/**
 * Parse a dimension vector IRI into an array of 8 exponents.
 * Returns null if the IRI doesn't match the expected pattern.
 */
function parseDimVec(iri: string): number[] | null {
  // Extract local name
  let localName = iri;
  if (iri.startsWith(QKDV)) {
    localName = iri.substring(QKDV.length);
  } else {
    const hashIdx = iri.lastIndexOf('#');
    const slashIdx = iri.lastIndexOf('/');
    const idx = Math.max(hashIdx, slashIdx);
    if (idx >= 0) {
      localName = iri.substring(idx + 1);
    }
  }

  // Parse pattern like A0E1L0I0M0H0T-2D0
  const regex = /^A(-?\d+)E(-?\d+)L(-?\d+)I(-?\d+)M(-?\d+)H(-?\d+)T(-?\d+)D(-?\d+)$/;
  const match = localName.match(regex);
  if (!match) return null;

  return match.slice(1).map(Number);
}

/**
 * Build a dimension vector IRI from an array of 8 exponents.
 */
function buildDimVecIri(exponents: number[]): string {
  const parts = DIM_CODES.map((code, i) => `${code}${exponents[i]}`).join('');
  return QKDV + parts;
}

// ─── Native qfn: Function Implementations ────────────────────────────────────

/**
 * qfn:dimVec.pow(dimVecIRI, exponent) → dimVecIRI
 * Element-wise exponentiation: multiply each dimension exponent by the given power.
 */
function dimVecPow(args: RDF.Term[]): Promise<RDF.Term> {
  if (args.length < 2) {
    return Promise.resolve(N3.DataFactory.namedNode(`${QFN}Unbound`));
  }

  const dimVecIri = args[0].value;
  const exponent = parseFloat(args[1].value);
  const exponents = parseDimVec(dimVecIri);

  if (!exponents || isNaN(exponent)) {
    return Promise.resolve(N3.DataFactory.namedNode(`${QFN}Unbound`));
  }

  const result = exponents.map(e => e * exponent);
  return Promise.resolve(N3.DataFactory.namedNode(buildDimVecIri(result)));
}

/**
 * qfn:dimVec.multiply(dimVecIRI1, dimVecIRI2) → dimVecIRI
 * Element-wise multiplication: add corresponding exponents of two dimension vectors.
 */
function dimVecMultiply(args: RDF.Term[]): Promise<RDF.Term> {
  if (args.length < 2) {
    return Promise.resolve(N3.DataFactory.namedNode(`${QFN}Unbound`));
  }

  const vec1 = parseDimVec(args[0].value);
  const vec2 = parseDimVec(args[1].value);

  if (!vec1 || !vec2) {
    return Promise.resolve(N3.DataFactory.namedNode(`${QFN}Unbound`));
  }

  const result = vec1.map((e, i) => e + vec2[i]);
  return Promise.resolve(N3.DataFactory.namedNode(buildDimVecIri(result)));
}

/**
 * qfn:bound(value) → boolean
 * Returns true if the value is not qfn:Unbound.
 */
function qfnBound(args: RDF.Term[]): Promise<RDF.Term> {
  if (args.length < 1) {
    return Promise.resolve(N3.DataFactory.literal('false', N3.DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#boolean')));
  }
  const isBound = args[0].value !== `${QFN}Unbound`;
  return Promise.resolve(
    N3.DataFactory.literal(
      isBound ? 'true' : 'false',
      N3.DataFactory.namedNode('http://www.w3.org/2001/XMLSchema#boolean')
    )
  );
}

/**
 * qfn:localname(iri) → string
 * Extracts the local name (fragment or last path segment) from an IRI.
 */
function qfnLocalname(args: RDF.Term[]): Promise<RDF.Term> {
  if (args.length < 1) {
    return Promise.resolve(N3.DataFactory.literal(''));
  }
  const iri = args[0].value;
  const hashIdx = iri.lastIndexOf('#');
  if (hashIdx >= 0) {
    return Promise.resolve(N3.DataFactory.literal(iri.substring(hashIdx + 1)));
  }
  const slashIdx = iri.lastIndexOf('/');
  if (slashIdx >= 0) {
    return Promise.resolve(N3.DataFactory.literal(iri.substring(slashIdx + 1)));
  }
  return Promise.resolve(N3.DataFactory.literal(iri));
}

// ─── sh:SPARQLFunction Support ───────────────────────────────────────────────

interface SPARQLFunctionDef {
  functionIRI: string;
  parameterPaths: string[];  // Ordered parameter path IRIs (used as variable names)
  selectQuery: string;
  returnType: string;
}

/**
 * Extract all sh:SPARQLFunction definitions from a shapes store.
 */
function extractSPARQLFunctions(shapesStore: N3.Store): SPARQLFunctionDef[] {
  const functions: SPARQLFunctionDef[] = [];

  // Find all ?fn a sh:SPARQLFunction
  const fnQuads = shapesStore.getQuads(
    null,
    N3.DataFactory.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'),
    N3.DataFactory.namedNode(`${SH}SPARQLFunction`),
    null
  );

  for (const fq of fnQuads) {
    const fnNode = fq.subject;
    const functionIRI = fnNode.value;

    // Get sh:select
    const selectQuads = shapesStore.getQuads(fnNode, N3.DataFactory.namedNode(`${SH}select`), null, null);
    if (selectQuads.length === 0) continue;
    const selectQuery = selectQuads[0].object.value;

    // Get sh:returnType
    const returnTypeQuads = shapesStore.getQuads(fnNode, N3.DataFactory.namedNode(`${SH}returnType`), null, null);
    const returnType = returnTypeQuads.length > 0 ? returnTypeQuads[0].object.value : '';

    // Get sh:parameter nodes, ordered by sh:order
    const paramQuads = shapesStore.getQuads(fnNode, N3.DataFactory.namedNode(`${SH}parameter`), null, null);
    const params: Array<{ order: number; path: string }> = [];

    for (const pq of paramQuads) {
      const paramNode = pq.object;
      const orderQuads = shapesStore.getQuads(paramNode, N3.DataFactory.namedNode(`${SH}order`), null, null);
      const pathQuads = shapesStore.getQuads(paramNode, N3.DataFactory.namedNode(`${SH}path`), null, null);

      const order = orderQuads.length > 0 ? parseInt(orderQuads[0].object.value, 10) : 0;
      const path = pathQuads.length > 0 ? pathQuads[0].object.value : '';

      if (path) {
        params.push({ order, path });
      }
    }

    // Sort parameters by sh:order
    params.sort((a, b) => a.order - b.order);
    const parameterPaths = params.map(p => p.path);

    // Get prefixes from sh:prefixes chain
    const prefixDecls = extractFunctionPrefixes(shapesStore, fnNode);
    const prefixString = prefixDecls
      .map(p => `PREFIX ${p.prefix}: <${p.namespace}>`)
      .join('\n');

    const fullQuery = prefixString ? prefixString + '\n' + selectQuery : selectQuery;

    functions.push({ functionIRI, parameterPaths, selectQuery: fullQuery, returnType });
  }

  return functions;
}

/**
 * Extract prefix declarations from a function's sh:prefixes chain.
 */
function extractFunctionPrefixes(
  store: N3.Store,
  fnNode: N3.Term
): Array<{ prefix: string; namespace: string }> {
  const prefixes: Array<{ prefix: string; namespace: string }> = [];

  const pfxQuads = store.getQuads(fnNode, `${SH}prefixes`, null, null);
  for (const pfxQ of pfxQuads) {
    const pfxNode = pfxQ.object;

    const declQuads = store.getQuads(pfxNode, `${SH}declare`, null, null);
    for (const declQ of declQuads) {
      const declNode = declQ.object;

      const prefixQuads = store.getQuads(declNode, `${SH}prefix`, null, null);
      const nsQuads = store.getQuads(declNode, `${SH}namespace`, null, null);

      if (prefixQuads.length > 0 && nsQuads.length > 0) {
        prefixes.push({
          prefix: prefixQuads[0].object.value,
          namespace: nsQuads[0].object.value,
        });
      }
    }
  }

  return prefixes;
}

/**
 * Build a Comunica extension functions map from a shapes store and data store.
 *
 * Registers:
 * 1. Native helper functions (qfn:dimVec.pow, qfn:dimVec.multiply, qfn:bound, qfn:localname)
 * 2. sh:SPARQLFunction definitions from the shapes store (query-based functions)
 *
 * The returned map can be passed to Comunica's queryBindings via the
 * extensionFunctions context parameter.
 */
export function buildExtensionFunctions(
  shapesStore: N3.Store,
  dataStore: N3.Store,
  engine: QueryEngine
): Record<string, (args: RDF.Term[]) => Promise<RDF.Term>> {
  const extensions: Record<string, (args: RDF.Term[]) => Promise<RDF.Term>> = {};

  // Register native helper functions
  extensions[`${QFN}dimVec.pow`] = dimVecPow;
  extensions[`${QFN}dimVec.multiply`] = dimVecMultiply;
  extensions[`${QFN}bound`] = qfnBound;
  extensions[`${QFN}localname`] = qfnLocalname;

  // Extract and register sh:SPARQLFunction definitions
  const sparqlFunctions = extractSPARQLFunctions(shapesStore);

  for (const fn of sparqlFunctions) {
    const { functionIRI, parameterPaths, selectQuery, returnType } = fn;

    extensions[functionIRI] = async (args: RDF.Term[]): Promise<RDF.Term> => {
      // Build VALUES clause to bind parameters
      // The sh:parameter paths define variable names — extract local name as the SPARQL variable
      const bindings: string[] = [];
      for (let i = 0; i < parameterPaths.length && i < args.length; i++) {
        const paramPath = parameterPaths[i];
        // Extract variable name from parameter path IRI (local name)
        let varName = paramPath;
        const hashIdx = paramPath.lastIndexOf('#');
        if (hashIdx >= 0) varName = paramPath.substring(hashIdx + 1);
        const slashIdx = varName.lastIndexOf('/');
        if (slashIdx >= 0) varName = varName.substring(slashIdx + 1);

        const arg = args[i];
        if (arg.termType === 'NamedNode') {
          bindings.push(`VALUES ?${varName} { <${arg.value}> }`);
        } else if (arg.termType === 'Literal') {
          bindings.push(`VALUES ?${varName} { "${arg.value}" }`);
        }
      }

      // Inject bindings into the query
      let query = selectQuery;
      if (bindings.length > 0) {
        query = query.replace(/WHERE\s*\{/i, `WHERE {\n  ${bindings.join('\n  ')}\n`);
      }

      try {
        const bindingsRes = await engine.queryBindings(query, {
          sources: [dataStore],
          extensionFunctions: extensions, // Allow recursive function calls
        });
        const rows = await bindingsRes.toArray();

        if (rows.length > 0) {
          const resultTerm = rows[0].get('result');
          if (resultTerm) {
            return resultTerm;
          }
        }

        // No result — return Unbound
        return N3.DataFactory.namedNode(`${QFN}Unbound`);
      } catch (err: any) {
        console.warn(`sh:SPARQLFunction ${functionIRI} query error:`, err?.message || err);
        return N3.DataFactory.namedNode(`${QFN}Unbound`);
      }
    };
  }

  // console.log(`Registered ${Object.keys(extensions).length} extension functions (${sparqlFunctions.length} SPARQL-based)`);

  return extensions;
}
