import * as N3 from 'n3';
import type { QueryEngine } from '@comunica/query-sparql';
import { convertArrayToDictionary, termToTypeAndValue, termToObject } from './rdf-utils';
import type { ParseState } from './n3-parser';

const { defaultGraph } = N3.DataFactory;

/**
 * Result of a SPARQL CONSTRUCT / DESCRIBE / SELECT-as-quads query: the
 * elm-qudt wire shape (`JSONdataModel`).
 */
export type QueryResultJSONdataModel = {
  baseURI: string;
  quads: Array<{
    subject: ReturnType<typeof termToTypeAndValue>;
    predicate: ReturnType<typeof termToTypeAndValue>;
    object: ReturnType<typeof termToObject>;
    graph: ReturnType<typeof termToTypeAndValue>;
  }>;
  prefixes: Array<{ prefix: string; iri: string }>;
};

/**
 * Run a SPARQL query against the session's N3.Store and return the
 * elm-qudt JSON wire shape. Throws on Comunica errors so the caller
 * can route them to its preferred error channel.
 */
export async function queryN3(
  engine: QueryEngine,
  state: ParseState,
  query: string
): Promise<QueryResultJSONdataModel> {
  const bindingsRes = await engine.queryBindings(query, { sources: [state.quadStore] });
  const rows = await bindingsRes.toArray();
  const prefixesDictionary = convertArrayToDictionary(state.prefixObjects);

  const jsonQuads = rows.flatMap((b: any) => {
    const s = b.get('s');
    const p = b.get('p');
    const o = b.get('o');
    const g = b.get('g');
    if (!g || !s || !p || !o) return [];
    return [
      {
        subject: termToTypeAndValue(s, prefixesDictionary),
        predicate: termToTypeAndValue(p, prefixesDictionary),
        object: termToObject(o, prefixesDictionary),
        graph: termToTypeAndValue(g, prefixesDictionary),
      },
    ];
  });

  return {
    baseURI: state.currentBaseURI,
    quads: jsonQuads,
    prefixes: state.prefixObjects,
  };
}

/**
 * Standard SPARQL JSON results format
 * (https://www.w3.org/TR/sparql11-results-json/).
 */
export type SparqlTabularResults = {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, Record<string, string>>> };
};

/**
 * Run a SPARQL SELECT and return SPARQL JSON results (preserves tabular
 * structure rather than reducing to quads). Throws on Comunica errors.
 *
 * Returns a JSON string for parity with the previous send-via-port
 * behaviour, where the Elm side parses a string.
 */
export async function queryN3Tabular(
  engine: QueryEngine,
  state: ParseState,
  query: string
): Promise<string> {
  const bindingsRes = await engine.queryBindings(query, { sources: [state.quadStore] });
  const rows = await bindingsRes.toArray();

  const vars: string[] =
    rows.length > 0 ? Array.from((rows[0] as any).keys()).map((k: any) => k.value) : [];

  const bindings = rows.map((row: any) => {
    const binding: Record<string, Record<string, string>> = {};
    for (const varName of vars) {
      const term = row.get(varName);
      if (term) {
        const entry: Record<string, string> = {
          type:
            term.termType === 'NamedNode'
              ? 'uri'
              : term.termType === 'BlankNode'
                ? 'bnode'
                : 'literal',
          value: term.value,
        };
        if (term.language) {
          entry['xml:lang'] = term.language;
        }
        if (term.datatype && term.datatype.value !== 'http://www.w3.org/2001/XMLSchema#string') {
          entry.datatype = term.datatype.value;
        }
        binding[varName] = entry;
      }
    }
    return binding;
  });

  return JSON.stringify({ head: { vars }, results: { bindings } });
}
