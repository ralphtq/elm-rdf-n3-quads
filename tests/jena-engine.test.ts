import { describe, it, expect, vi } from 'vitest';
import { QuadStoreSession, JenaEngine, ValidationReport } from '../src/index';

const sampleData = `
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
ex:Alice a ex:Person .
`;

const sampleShapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
ex:PersonShape a sh:NodeShape ;
  sh:targetClass ex:Person .
`;

const makeRequest = () => ({
  dataGraphSource: { kind: 'ttl', content: sampleData },
  shapesGraphSource: { kind: 'ttl', content: sampleShapes },
});

const okReport = (engineHint = 'jena'): ValidationReport => ({
  conforms: true,
  results: [],
  shapeDefinitions: [],
  subjectsTargeted: 1,
  dataSubjects: 1,
  engineInfo: { engine: engineHint, jenaFallback: false, jenaError: '', elapsedMs: 0 },
});

describe('JenaEngine injection on QuadStoreSession', () => {
  it('JS engine is used when no jenaEngine is injected', async () => {
    const session = new QuadStoreSession();
    const report = await session.validateSHACL(makeRequest());
    expect(report.engineInfo.engine).toBe('javascript');
    expect(report.engineInfo.jenaFallback).toBe(false);
  });

  it('Jena engine is used when available and validates successfully', async () => {
    const jenaEngine: JenaEngine = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateGraphs: vi.fn().mockResolvedValue(okReport('jena')),
    };
    const session = new QuadStoreSession({ jenaEngine });
    const report = await session.validateSHACL(makeRequest());
    expect(jenaEngine.isAvailable).toHaveBeenCalled();
    expect(jenaEngine.validateGraphs).toHaveBeenCalled();
    expect(report.engineInfo.engine).toBe('jena');
  });

  it('Falls back to JS when Jena reports unavailable (no validateGraphs call)', async () => {
    const jenaEngine: JenaEngine = {
      isAvailable: vi.fn().mockResolvedValue(false),
      validateGraphs: vi.fn(),
    };
    const session = new QuadStoreSession({ jenaEngine });
    const report = await session.validateSHACL(makeRequest());
    expect(jenaEngine.isAvailable).toHaveBeenCalled();
    expect(jenaEngine.validateGraphs).not.toHaveBeenCalled();
    expect(report.engineInfo.engine).toBe('javascript');
    expect(report.engineInfo.jenaFallback).toBe(false);
  });

  it('Falls back to JS when Jena validateGraphs throws; records jenaFallback + jenaError', async () => {
    const jenaEngine: JenaEngine = {
      isAvailable: vi.fn().mockResolvedValue(true),
      validateGraphs: vi.fn().mockRejectedValue(new Error('Jena server crashed')),
    };
    const session = new QuadStoreSession({ jenaEngine });
    const report = await session.validateSHACL(makeRequest());
    expect(report.engineInfo.engine).toBe('javascript');
    expect(report.engineInfo.jenaFallback).toBe(true);
    expect(report.engineInfo.jenaError).toBe('Jena server crashed');
  });

  it('Exposes jenaEngine as a readonly property on the session', () => {
    const jenaEngine: JenaEngine = {
      isAvailable: async () => false,
      validateGraphs: async () => okReport('jena'),
    };
    const session = new QuadStoreSession({ jenaEngine });
    expect(session.jenaEngine).toBe(jenaEngine);
  });
});
