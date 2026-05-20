/**
 * Direct N3.Store traversal for in-scope schema resources.
 *
 * Replaces the slow SPARQL query `InScopeSchemaResourcesQuery` with
 * direct store.getQuads() calls. For each in-scope type, retrieves:
 *   1. All triples of the type itself
 *   2. All triples of its sh:property shapes
 *   3. All triples of property groups (via sh:property -> sh:group)
 *
 * Returns the same JSONrdfQuad payload format that queryN3 produces.
 */

import * as N3 from 'n3';
import { termToTypeAndValue, termToObject, convertArrayToDictionary } from './rdf-utils';
import type { ParseState } from './n3-parser';
import type { QueryResultJSONdataModel } from './n3-query';

const SH_PROPERTY = 'http://www.w3.org/ns/shacl#property';
const SH_GROUP = 'http://www.w3.org/ns/shacl#group';

function getQuadsForSubject(store: N3.Store, subjectIRI: string): N3.Quad[] {
  return store.getQuads(N3.DataFactory.namedNode(subjectIRI), null, null, null);
}

/**
 * Walk the N3.Store for in-scope schema resources and return the same
 * JSON wire shape as queryN3.
 *
 * No `app` parameter; no port sends. Throws on errors.
 */
export function queryInScopeSchemaResources(
  state: ParseState,
  typeIRIs: string[]
): QueryResultJSONdataModel {
  const store = state.quadStore;
  const prefixesDictionary = convertArrayToDictionary(state.prefixObjects);
  const seen = new Set<string>();
  const resultQuads: N3.Quad[] = [];

  function addQuads(quads: N3.Quad[]) {
    for (const q of quads) {
      const key = `${q.subject.value}|${q.predicate.value}|${q.object.value}|${q.graph.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        resultQuads.push(q);
      }
    }
  }

  for (const typeIRI of typeIRIs) {
    // 1. All triples of the type itself.
    const typeQuads = getQuadsForSubject(store, typeIRI);
    addQuads(typeQuads);

    // 2. Property shapes: ?c sh:property ?ps. ?ps ?p ?o.
    const propertyQuads = store.getQuads(
      N3.DataFactory.namedNode(typeIRI),
      N3.DataFactory.namedNode(SH_PROPERTY),
      null,
      null
    );

    for (const pq of propertyQuads) {
      const propertyShapeNode = pq.object;
      const psQuads = store.getQuads(propertyShapeNode as any, null, null, null);
      addQuads(psQuads);

      // 3. Property groups: ?ps sh:group ?g. ?g ?p ?o.
      const groupQuads = store.getQuads(
        propertyShapeNode as any,
        N3.DataFactory.namedNode(SH_GROUP),
        null,
        null
      );

      for (const gq of groupQuads) {
        const groupNode = gq.object;
        const groupTriples = store.getQuads(groupNode as any, null, null, null);
        addQuads(groupTriples);
      }
    }
  }

  const jsonQuads = resultQuads.map((q) => ({
    subject: termToTypeAndValue(q.subject, prefixesDictionary),
    predicate: termToTypeAndValue(q.predicate, prefixesDictionary),
    object: termToObject(q.object, prefixesDictionary),
    graph: termToTypeAndValue(q.graph, prefixesDictionary),
  }));

  return {
    baseURI: state.currentBaseURI,
    quads: jsonQuads,
    prefixes: state.prefixObjects,
  };
}
