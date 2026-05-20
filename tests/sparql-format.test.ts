import { describe, it, expect } from 'vitest';
import { formatSPARQL, formatQueryKindSPARQL } from '../src/sparql-format';
import type { PrefixObject } from '../src/rdf-utils';

const prefixes: PrefixObject[] = [
  { prefix: 'qudt', iri: 'http://qudt.org/schema/qudt/' },
  { prefix: 'rdf', iri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' },
];

describe('formatSPARQL', () => {
  it('returns a pretty-printed string for a valid SELECT query', async () => {
    const ugly = 'PREFIX rdf:<http://www.w3.org/1999/02/22-rdf-syntax-ns#> SELECT ?s WHERE{?s ?p ?o}';
    const formatted = await formatSPARQL(prefixes, ugly);
    expect(formatted).toContain('SELECT');
    expect(formatted).toContain('WHERE');
  });

  it('preserves the PREFIX declarations from the input query', async () => {
    const input = 'PREFIX qudt:<http://qudt.org/schema/qudt/> SELECT ?u WHERE{?u a qudt:Unit}';
    const formatted = await formatSPARQL(prefixes, input);
    expect(formatted).toContain('PREFIX qudt:');
  });

  it('rejects on malformed input', async () => {
    await expect(formatSPARQL(prefixes, 'NOT A QUERY')).rejects.toThrow();
  });
});

describe('formatQueryKindSPARQL', () => {
  it('returns a record with graphId, graphQueryKindKey, and formatted sparql', async () => {
    const result = await formatQueryKindSPARQL(
      prefixes,
      'http://example/g',
      'all-classes',
      'SELECT ?c WHERE { ?c a ?t }'
    );
    expect(result.graphId).toBe('http://example/g');
    expect(result.graphQueryKindKey).toBe('all-classes');
    expect(result.sparql).toContain('SELECT');
  });

  it('rejects on malformed input', async () => {
    await expect(
      formatQueryKindSPARQL(prefixes, 'g1', 'k1', 'NOPE NOT SPARQL')
    ).rejects.toThrow();
  });
});
