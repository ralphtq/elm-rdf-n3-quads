import * as N3 from 'n3';
import { Parser, Store } from 'n3';
import { PrefixObject, allStoredQuads } from './rdf-utils';

const { namedNode, quad } = N3.DataFactory;

export type ParseState = {
  quadStore: N3.Store;
  prefixObjects: PrefixObject[];
  currentBaseURI: string;
  currentQuadsCount: number;
  quads: N3.Quad[];
};

/**
 * Result of a successful parseN3 invocation. Mirrors the payload the
 * elm-qudt app sends to the `quadStoreUpdated` port plus everything the
 * caller needs to derive other ports' payloads.
 */
export type ParseResult = {
  baseURI: string;
  /** New quads added by this parse call (post-count minus pre-count). */
  numberOfQuads: number;
  /** Total quads now resident in the store. */
  totalQuadsInStore: number;
  /** Value side of every owl:imports triple parsed from this TTL. */
  imports: string[];
  /** Accumulated prefix objects in the session after this parse. */
  prefixObjects: PrefixObject[];
  /**
   * The owl:imports quads in a shape suitable for direct JSON wire
   * transmission. Kept around for callers that still pipe them through
   * the `receiveJSONdataModel` / `adminGetsJSONdataModel` channels.
   */
  selectedQuads: Array<{
    subject: N3.Term;
    predicate: N3.Term;
    object: {
      termType: string;
      value: string;
      language: string;
      datatype: { termType: string; value: string; id: string } | any;
      id: string;
    };
    graph: N3.Term;
  }>;
};

export function makeEmptyParseState(): ParseState {
  return {
    quadStore: new Store(),
    prefixObjects: [],
    currentBaseURI: '',
    currentQuadsCount: 0,
    quads: [],
  };
}

const OWL_IMPORTS = 'http://www.w3.org/2002/07/owl#imports';

/**
 * Parse TTL/N3 content into the session's quad store and return a
 * structured `ParseResult`. Mutates `state` (adds quads to its
 * `quadStore`, appends prefixes, updates `currentQuadsCount` and
 * `currentBaseURI`).
 *
 * If `initializeStore` is true, the existing N3.Store and prefixes are
 * discarded before parsing — useful when re-importing under a fresh
 * baseURI.
 *
 * No `app` parameter; no port sends. The caller decides what to do
 * with the result.
 */
export async function parseN3(
  state: ParseState,
  initializeStore: boolean,
  baseURI: string,
  ttl: string
): Promise<ParseResult> {
  let prefixes: any = [];

  const parser = new Parser();
  const parsePromise = new Promise<void>((resolve, reject) => {
    if (initializeStore) {
      state.quadStore = new Store();
      state.prefixObjects = [];
      state.currentBaseURI = baseURI;
    }
    parser.parse(ttl, (error, quadObj, maybePrefixes) => {
      if (error) {
        reject(error);
      } else if (quadObj) {
        const graphQuad: N3.Quad = quad(
          quadObj.subject,
          quadObj.predicate,
          quadObj.object,
          namedNode(baseURI)
        );
        state.quadStore.addQuad(graphQuad);
      } else {
        prefixes = maybePrefixes;
        resolve();
      }
    });
  });

  await parsePromise;
  const previousQuadsCount = state.currentQuadsCount;
  state.quadStore.addQuads(state.quads);

  const prefixesArray = Object.entries(prefixes);
  const newPrefixObjects: PrefixObject[] = prefixesArray.map(([prefix, iri]) => ({
    prefix,
    iri: iri as string,
  }));
  state.prefixObjects = state.prefixObjects.concat(newPrefixObjects);

  const quadsFromStore = allStoredQuads(state.quadStore);

  const selectedQuads = quadsFromStore
    .filter((q) => q.predicate?.value === OWL_IMPORTS)
    .map((q) => ({
      subject: q.subject,
      predicate: q.predicate,
      object: {
        termType: q.object.termType,
        value: q.object.value,
        language: (q.object as any).language === undefined ? '' : (q.object as any).language,
        datatype:
          (q.object as any).datatype === undefined
            ? { termType: '', value: '', id: '' }
            : (q.object as any).datatype,
        id: '',
      },
      graph: q.graph,
    }));

  const imports = selectedQuads.map((q) => q.object.value);

  state.currentQuadsCount = quadsFromStore.length;
  state.currentBaseURI = baseURI;

  return {
    baseURI,
    numberOfQuads: quadsFromStore.length - previousQuadsCount,
    totalQuadsInStore: quadsFromStore.length,
    imports,
    prefixObjects: state.prefixObjects,
    selectedQuads,
  };
}
