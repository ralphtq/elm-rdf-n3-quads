// Public API of @ralphtq/rdf-n3-quads

export { QuadStoreSession } from './quad-store-session';
export type { QuadStoreSessionOptions } from './quad-store-session';

export type {
  ParseState,
  ParseResult,
} from './n3-parser';
export { makeEmptyParseState, parseN3 } from './n3-parser';

export type {
  QueryResultJSONdataModel,
} from './n3-query';
export { queryN3, queryN3Tabular } from './n3-query';

export { queryInScopeSchemaResources } from './schema-resources-query';

export { writeQuads, writeJSONLD } from './rdf-writers';

export {
  formatSPARQL,
  formatQueryKindSPARQL,
} from './sparql-format';
export type { QueryKindSPARQLResponse } from './sparql-format';

export type {
  ShapeEntryJSON,
  PrefixEntryJSON,
  ShapeCollectionJSON,
} from './shape-parser';
export { parseShapeCollection } from './shape-parser';

export {
  catalogZipFromDataUrl,
  getZipContent,
  getZipContentWithBase,
  clearZipCache,
} from './zip-catalog';
export type { ZipCatalogEntry } from './zip-catalog';

export {
  validateSHACL,
  validateSchemaQA,
  validateSHACLwithStore,
  validateGraphs,
  parseTurtleToStore,
} from './shacl-validator';
export type {
  ValidationResult,
  ShapeDefinition,
  EngineInfo,
  ValidationReport,
  JenaEngine,
} from './shacl-validator';

export type {
  PrefixObject,
  TypeAndValue,
} from './rdf-utils';
export {
  convertArrayToDictionary,
  shortenIri,
  toCurie,
  termToTypeAndValue,
  termToObject,
  jsonObjectToTerm,
  jsonTypeAndValueToN3Term,
  allStoredQuads,
} from './rdf-utils';

export {
  validateSparqlConstraints,
  resolveSparqlTargets,
} from './sparql-constraint-validator';

export { buildExtensionFunctions } from './shacl-functions';
