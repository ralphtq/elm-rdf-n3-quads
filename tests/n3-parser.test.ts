import { describe, it, expect } from 'vitest';
import { makeEmptyParseState, parseN3 } from '../src/n3-parser';

const sampleTTL = `
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .

ex:Alice a ex:Person .
ex:Bob a ex:Person .
<http://example.org/myOntology> a owl:Ontology ;
  owl:imports <http://other.example.org/foundation> ,
              <http://other.example.org/extras> .
`;

describe('parseN3', () => {
  it('populates the quad store and returns counts', async () => {
    const state = makeEmptyParseState();
    const result = await parseN3(state, false, 'http://example.org/test', sampleTTL);
    expect(result.baseURI).toBe('http://example.org/test');
    expect(result.totalQuadsInStore).toBe(5);
    expect(result.numberOfQuads).toBe(5);
    expect(state.quadStore.size).toBe(5);
  });

  it('captures owl:imports targets in `imports`', async () => {
    const state = makeEmptyParseState();
    const result = await parseN3(state, false, 'http://example.org/test', sampleTTL);
    expect(result.imports).toHaveLength(2);
    expect(result.imports).toContain('http://other.example.org/foundation');
    expect(result.imports).toContain('http://other.example.org/extras');
  });

  it('accumulates prefixObjects across parses', async () => {
    const state = makeEmptyParseState();
    await parseN3(state, false, 'http://example.org/test', sampleTTL);
    const prefixNames = state.prefixObjects.map((p) => p.prefix);
    expect(prefixNames).toContain('ex');
    expect(prefixNames).toContain('rdf');
    expect(prefixNames).toContain('owl');
  });

  it('initializeStore=true wipes the existing store', async () => {
    const state = makeEmptyParseState();
    await parseN3(state, false, 'http://example.org/first', sampleTTL);
    expect(state.quadStore.size).toBe(5);

    await parseN3(
      state,
      true, // wipe
      'http://example.org/second',
      '@prefix ex: <http://example.org/> . ex:Carol a ex:Person .'
    );
    expect(state.quadStore.size).toBe(1);
    expect(state.currentBaseURI).toBe('http://example.org/second');
  });

  it('does not couple to Elm ports (signature has no app argument)', async () => {
    // Compile-time check: parseN3(state, initializeStore, baseURI, ttl).
    const state = makeEmptyParseState();
    const result = await parseN3(state, false, 'http://x', '');
    expect(result.totalQuadsInStore).toBe(0);
  });
});
