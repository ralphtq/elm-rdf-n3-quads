import * as SPARQLJS from 'sparqljs';
import { PrefixObject, convertArrayToDictionary } from './rdf-utils';

export interface QueryKindSPARQLResponse {
  graphId: string;
  graphQueryKindKey: string;
  sparql: string;
}

export async function formatSPARQL(
  prefixObjects: PrefixObject[],
  sparqlString: string
): Promise<string> {
  // prefixObjects is currently unused by the formatter (sparqljs preserves the
  // prefixes embedded in the query itself), but we keep the parameter so the
  // call signature mirrors formatQueryKindSPARQL and reads consistently from
  // the port glue.
  void prefixObjects;
  const parser = new SPARQLJS.Parser();
  const generator = new SPARQLJS.Generator({
    allPrefixes: true,
    indent: "  ",
  });
  const parsed = parser.parse(sparqlString);
  return generator.stringify(parsed);
}

export async function formatQueryKindSPARQL(
  prefixObjects: PrefixObject[],
  graphId: string,
  graphQueryKindKey: string,
  sparqlString: string
): Promise<QueryKindSPARQLResponse> {
  void prefixObjects;
  const parser = new SPARQLJS.Parser();
  const generator = new SPARQLJS.Generator({
    allPrefixes: true,
    indent: "  ",
  });
  const parsed = parser.parse(sparqlString);
  return {
    graphId,
    graphQueryKindKey,
    sparql: generator.stringify(parsed),
  };
}
