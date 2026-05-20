import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as N3 from 'n3';
import { termToTypeAndValue, termToObject, type PrefixObject } from '../src/rdf-utils';

// Cross-language wire-shape verification.
//
// This test produces JSON via the SAME functions (termToTypeAndValue,
// termToObject) that the runtime code path uses to send wire payloads
// to the Elm side. Then it loads the shared fixture file
// (tests/fixtures/sample-data-model.json) — the SAME file the Elm
// `WireRoundTripTests` suite decodes — and asserts that the
// TS-produced JSON has the same shape (key set + per-quad termType).
//
// If a TS code change alters the wire shape (renames a field, drops a
// key, changes nullability), this test fails. The companion Elm test
// fails too once the fixture file is updated to match the new shape.

const FIXTURE_PATH = './tests/fixtures/sample-data-model.json';

const aliceIRI = 'http://example.org/Alice';
const personIRI = 'http://example.org/Person';
const rdfType = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const langStringIRI = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const xsdInteger = 'http://www.w3.org/2001/XMLSchema#integer';
const rdfsLabel = 'http://www.w3.org/2000/01/rdf-schema#label';

const prefixesEmpty: Record<string, string> = {};

describe('Cross-language wire-shape fixture', () => {
  it('fixture file exists and is valid JSON', () => {
    const raw = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('baseURI');
    expect(parsed).toHaveProperty('quads');
    expect(parsed).toHaveProperty('prefixes');
    expect(parsed.quads).toHaveLength(3);
    expect(parsed.prefixes).toHaveLength(4);
  });

  it('TS-produced NamedNode term matches the fixture shape', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    const aliceFromTS = termToTypeAndValue(N3.DataFactory.namedNode(aliceIRI), prefixesEmpty);

    // First quad subject is the canonical NamedNode reference.
    const aliceFromFixture = fixture.quads[0].subject;
    expect(aliceFromTS.termType).toBe(aliceFromFixture.termType);
    expect(aliceFromTS.value).toBe(aliceFromFixture.value);
    expect(aliceFromTS.id).toBe(aliceFromFixture.id);
  });

  it('TS-produced NamedNode object (with null language + datatype) matches fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    const personFromTS = termToObject(N3.DataFactory.namedNode(personIRI), prefixesEmpty);
    const personFromFixture = fixture.quads[0].object;

    expect(personFromTS.termType).toBe(personFromFixture.termType);
    expect(personFromTS.value).toBe(personFromFixture.value);
    expect(personFromTS.id).toBe(personFromFixture.id);
    // language + datatype are null/undefined on NamedNode objects
    expect(personFromTS.language == null).toBe(true);
    expect(personFromFixture.language).toBe(null);
    expect(personFromTS.datatype == null).toBe(true);
    expect(personFromFixture.datatype).toBe(null);
  });

  it('TS-produced language-tagged literal carries language + langString datatype', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    const literalTerm = N3.DataFactory.literal('hello', 'en');
    const fromTS = termToObject(literalTerm, prefixesEmpty);
    const fromFixture = fixture.quads[1].object;

    expect(fromTS.termType).toBe('Literal');
    expect(fromTS.value).toBe('hello');
    expect(fromTS.language).toBe('en');
    expect(fromFixture.language).toBe('en');
    // datatype for a language-tagged literal is rdf:langString
    expect((fromTS.datatype as any)?.value).toBe(langStringIRI);
    expect(fromFixture.datatype.value).toBe(langStringIRI);
  });

  it('TS-produced datatyped literal carries the typed datatype', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    const intLiteral = N3.DataFactory.literal('42', N3.DataFactory.namedNode(xsdInteger));
    const fromTS = termToObject(intLiteral, prefixesEmpty);
    const fromFixture = fixture.quads[2].object;

    expect(fromTS.termType).toBe('Literal');
    expect(fromTS.value).toBe('42');
    expect(fromTS.language == null).toBe(true);
    expect(fromFixture.language).toBe(null);
    expect((fromTS.datatype as any)?.value).toBe(xsdInteger);
    expect(fromFixture.datatype.value).toBe(xsdInteger);
  });

  it('PrefixObject array shape matches the fixture', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    const sample: PrefixObject = { prefix: 'ex', iri: 'http://example.org/' };
    // The fixture's first prefix is `ex` so this verifies the shape.
    expect(fixture.prefixes[0]).toEqual(sample);
    // Schema check: every entry must have exactly { prefix, iri }.
    for (const p of fixture.prefixes) {
      expect(Object.keys(p).sort()).toEqual(['iri', 'prefix']);
    }
  });

  it('every fixture object has the expected key set (drift detector)', () => {
    const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf-8'));
    for (const quad of fixture.quads) {
      expect(Object.keys(quad).sort()).toEqual(['graph', 'object', 'predicate', 'subject']);
      expect(Object.keys(quad.subject).sort()).toEqual(['id', 'termType', 'value']);
      expect(Object.keys(quad.predicate).sort()).toEqual(['id', 'termType', 'value']);
      expect(Object.keys(quad.object).sort()).toEqual(['datatype', 'id', 'language', 'termType', 'value']);
      expect(Object.keys(quad.graph).sort()).toEqual(['id', 'termType', 'value']);
    }
  });
});
