import { describe, it, expect } from 'vitest';
import { writeQuads, writeJSONLD } from '../src/rdf-writers';
import type { PrefixObject } from '../src/rdf-utils';

const prefixes: PrefixObject[] = [
  { prefix: 'ex', iri: 'http://example.org/' },
  { prefix: 'rdf', iri: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#' },
  { prefix: 'rdfs', iri: 'http://www.w3.org/2000/01/rdf-schema#' },
];

function namedNodeTerm(iri: string) {
  return { termType: 'NamedNode', value: iri, id: iri };
}

function namedNodeObject(iri: string) {
  return {
    termType: 'NamedNode',
    value: iri,
    id: iri,
    language: null,
    datatype: null,
  };
}

function quad(s: string, p: string, o: string, g: string = '') {
  return {
    subject: namedNodeTerm(s),
    predicate: namedNodeTerm(p),
    object: namedNodeObject(o),
    graph: g === '' ? { termType: 'NamedNode', value: '', id: '' } : namedNodeTerm(g),
  };
}

describe('writeQuads', () => {
  it('resolves to a TriG string containing the rendered triple', async () => {
    const result = await writeQuads(prefixes, [
      quad(
        'http://example.org/Alice',
        'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
        'http://example.org/Person'
      ),
    ]);
    expect(typeof result).toBe('string');
    expect(result).toContain('ex:Alice');
    expect(result).toContain('ex:Person');
  });

  it('emits @prefix declarations from the provided prefixObjects', async () => {
    const result = await writeQuads(prefixes, [
      quad('http://example.org/a', 'http://example.org/p', 'http://example.org/b'),
    ]);
    expect(result).toContain('@prefix ex:');
  });

  it('handles the empty-quad-list case without throwing', async () => {
    const result = await writeQuads(prefixes, []);
    expect(typeof result).toBe('string');
  });
});

describe('writeJSONLD', () => {
  it('resolves to a JSON-LD string with a context block', async () => {
    const result = await writeJSONLD(prefixes, [
      quad('http://example.org/a', 'http://example.org/p', 'http://example.org/b'),
    ]);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('@context');
    expect(JSON.stringify(parsed)).toContain('http://example.org/');
  });
});
