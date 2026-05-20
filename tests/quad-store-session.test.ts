import { describe, it, expect } from 'vitest';
import { QuadStoreSession } from '../src/quad-store-session';

const sampleTTL = `
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

ex:Alice a ex:Person .
ex:Bob a ex:Person ;
       ex:knows ex:Alice .
`;

describe('QuadStoreSession', () => {
  it('starts with an empty store and engine', () => {
    const session = new QuadStoreSession();
    expect(session.state.quadStore.size).toBe(0);
    expect(session.engine).toBeDefined();
  });

  it('parseTTL populates the store', async () => {
    const session = new QuadStoreSession();
    const result = await session.parseTTL(sampleTTL, 'http://example.org/g1');
    expect(result.totalQuadsInStore).toBe(3);
    expect(session.state.quadStore.size).toBe(3);
  });

  it('clearStore resets the session', async () => {
    const session = new QuadStoreSession();
    await session.parseTTL(sampleTTL, 'http://example.org/g1');
    expect(session.state.quadStore.size).toBe(3);
    session.clearStore();
    expect(session.state.quadStore.size).toBe(0);
    expect(session.state.prefixObjects).toEqual([]);
  });

  it('query returns the elm-qudt JSON wire shape with all triples', async () => {
    const session = new QuadStoreSession();
    await session.parseTTL(sampleTTL, 'http://example.org/g1');
    const result = await session.query('SELECT ?s ?p ?o ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
    expect(result.baseURI).toBe('http://example.org/g1');
    expect(result.quads.length).toBe(3);
    expect(result.prefixes.length).toBeGreaterThanOrEqual(2); // ex, rdf
  });

  it('queryTabular returns SPARQL JSON results format', async () => {
    const session = new QuadStoreSession();
    await session.parseTTL(sampleTTL, 'http://example.org/g1');
    const result = await session.queryTabular('SELECT ?s WHERE { GRAPH ?g { ?s a ?t } }');
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('head');
    expect(parsed).toHaveProperty('results');
    expect(parsed.head.vars).toContain('s');
  });

  it('writeTurtle round-trips a known quad', async () => {
    const session = new QuadStoreSession();
    await session.parseTTL(sampleTTL, 'http://example.org/g1');
    const quad = {
      subject: { termType: 'NamedNode', value: 'http://example.org/Carol', id: '' },
      predicate: { termType: 'NamedNode', value: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', id: '' },
      object: {
        termType: 'NamedNode',
        value: 'http://example.org/Person',
        id: '',
        language: null,
        datatype: null,
      },
      graph: { termType: 'NamedNode', value: '', id: '' },
    };
    const turtle = await session.writeTurtle([quad]);
    expect(turtle).toContain('Carol');
    expect(turtle).toContain('Person');
  });

  it('formatSPARQL returns a pretty-printed string', async () => {
    const session = new QuadStoreSession();
    const formatted = await session.formatSPARQL('SELECT ?s WHERE { ?s ?p ?o }');
    expect(formatted).toContain('SELECT');
  });

  it('externally-injected ParseState is reused', async () => {
    const a = new QuadStoreSession();
    await a.parseTTL(sampleTTL, 'http://example.org/g1');
    const b = new QuadStoreSession({ state: a.state });
    expect(b.state.quadStore.size).toBe(3);
  });
});
