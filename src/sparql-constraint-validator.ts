import * as N3 from 'n3';
import type { QueryEngine } from '@comunica/query-sparql';
import type { ValidationResult } from './shacl-validator';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBCLASSOF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

interface SparqlConstraintInfo {
  shapeIri: string;       // The shape that owns the constraint (for target resolution)
  constraintIri: string;  // The immediate parent of sh:sparql (may be a property shape blank node)
  selectQuery: string;
  message: string;
  severity: string;       // Full IRI of sh:severity (e.g., sh:Violation, sh:Warning, sh:Info)
}

/**
 * Extract all sh:sparql constraints from a shapes graph using N3 Store queries.
 */
function extractSparqlConstraints(shapesStore: N3.Store): SparqlConstraintInfo[] {
  const constraints: SparqlConstraintInfo[] = [];

  // Find all ?shape sh:sparql ?constraint triples
  const sparqlQuads = shapesStore.getQuads(null, `${SH}sparql`, null, null);

  for (const sq of sparqlQuads) {
    const constraintParent = sq.subject.value;
    const constraintNode = sq.object;

    // Determine the owning shape IRI for target resolution.
    // If the sh:sparql is on a property shape (blank node reachable via sh:property),
    // we need the parent NodeShape that has sh:targetClass.
    let shapeIri = constraintParent;
    const parentQuads = shapesStore.getQuads(null, `${SH}property`, sq.subject, null);
    if (parentQuads.length > 0) {
      shapeIri = parentQuads[0].subject.value;
    }

    // Get sh:select from the constraint node
    const selectQuads = shapesStore.getQuads(constraintNode, `${SH}select`, null, null);
    if (selectQuads.length === 0) continue;

    const selectQuery = selectQuads[0].object.value;

    // Get optional sh:message — check constraint node first, then shape as fallback
    const constraintMessageQuads = shapesStore.getQuads(constraintNode, `${SH}message`, null, null);
    const shapeMessageQuads = shapesStore.getQuads(sq.subject, `${SH}message`, null, null);
    const message = constraintMessageQuads.length > 0
      ? constraintMessageQuads[0].object.value
      : shapeMessageQuads.length > 0
        ? shapeMessageQuads[0].object.value
        : '';

    // Get prefixes from sh:prefixes -> sh:declare -> sh:prefix/sh:namespace
    const prefixDecls = extractPrefixes(shapesStore, constraintNode);
    const prefixString = prefixDecls
      .map(p => `PREFIX ${p.prefix}: <${p.namespace}>`)
      .join('\n');

    const fullQuery = prefixString ? prefixString + '\n' + selectQuery : selectQuery;

    // Get sh:severity from the shape (check the constraint parent first, then the owning shape)
    const severityQuads = shapesStore.getQuads(
      N3.DataFactory.namedNode(constraintParent), `${SH}severity`, null, null
    );
    let severity = `${SH}Violation`; // default per SHACL spec
    if (severityQuads.length > 0) {
      severity = severityQuads[0].object.value;
    } else if (shapeIri !== constraintParent) {
      // Check the owning shape if different from constraint parent
      const ownerSeverityQuads = shapesStore.getQuads(
        N3.DataFactory.namedNode(shapeIri), `${SH}severity`, null, null
      );
      if (ownerSeverityQuads.length > 0) {
        severity = ownerSeverityQuads[0].object.value;
      }
    }

    constraints.push({ shapeIri, constraintIri: constraintParent, selectQuery: fullQuery, message, severity });
  }

  return constraints;
}

/**
 * Extract prefix declarations from a constraint's sh:prefixes chain.
 * Follows: ?constraint sh:prefixes ?pfxNode . ?pfxNode sh:declare ?decl .
 *          ?decl sh:prefix ?prefix ; sh:namespace ?ns .
 */
function extractPrefixes(
  store: N3.Store,
  constraintNode: N3.Term
): Array<{ prefix: string; namespace: string }> {
  const prefixes: Array<{ prefix: string; namespace: string }> = [];

  const pfxQuads = store.getQuads(constraintNode, `${SH}prefixes`, null, null);
  for (const pfxQ of pfxQuads) {
    const pfxNode = pfxQ.object;

    const declQuads = store.getQuads(pfxNode, `${SH}declare`, null, null);
    for (const declQ of declQuads) {
      const declNode = declQ.object;

      const prefixQuads = store.getQuads(declNode, `${SH}prefix`, null, null);
      const nsQuads = store.getQuads(declNode, `${SH}namespace`, null, null);

      if (prefixQuads.length > 0 && nsQuads.length > 0) {
        prefixes.push({
          prefix: prefixQuads[0].object.value,
          namespace: nsQuads[0].object.value,
        });
      }
    }
  }

  return prefixes;
}

/**
 * Collect a class and all its subclasses by following rdfs:subClassOf transitively in the store.
 */
function collectSubClasses(store: N3.Store, classIri: string): Set<string> {
  const result = new Set<string>();
  const queue = [classIri];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (result.has(current)) continue;
    result.add(current);
    // Find ?sub rdfs:subClassOf ?current
    const subQuads = store.getQuads(null, RDFS_SUBCLASSOF, N3.DataFactory.namedNode(current), null);
    for (const sq of subQuads) {
      queue.push(sq.subject.value);
    }
  }
  return result;
}

/**
 * Find target nodes for a shape in the data graph.
 * Supports sh:targetClass and sh:targetNode.
 */
function findTargetNodes(shapesStore: N3.Store, dataStore: N3.Store, shapeIri: string): string[] {
  const targets: Set<string> = new Set();

  // sh:targetNode — direct target
  const targetNodeQuads = shapesStore.getQuads(
    N3.DataFactory.namedNode(shapeIri), `${SH}targetNode`, null, null
  );
  for (const q of targetNodeQuads) {
    targets.add(q.object.value);
  }

  // sh:targetClass — find all instances of the class (and its subclasses) in the data graph
  const targetClassQuads = shapesStore.getQuads(
    N3.DataFactory.namedNode(shapeIri), `${SH}targetClass`, null, null
  );
  for (const q of targetClassQuads) {
    const classIri = q.object.value;
    // Collect the target class and all its subclasses (transitive closure)
    const allClasses = collectSubClasses(dataStore, classIri);
    for (const cls of allClasses) {
      const instanceQuads = dataStore.getQuads(null, RDF_TYPE, N3.DataFactory.namedNode(cls), null);
      for (const iq of instanceQuads) {
        targets.add(iq.subject.value);
      }
    }
  }

  return Array.from(targets);
}

/**
 * Substitute {$this} and {?varName} placeholders in a message template.
 */
function substituteMessage(template: string, bindings: any, focusNode: string): string {
  // Substitute {$this} with the focus node IRI
  let result = template.replace(/\{\$this\}/g, focusNode);
  // Substitute {?varName} with binding values
  result = result.replace(/\{\?(\w+)\}/g, (_match, varName) => {
    const term = bindings.get(varName);
    return term ? term.value : `?${varName}`;
  });
  return result;
}

/**
 * Maximum number of concurrent SPARQL queries to run in parallel.
 * Balances throughput against memory/CPU pressure in Comunica.
 */
const CONCURRENCY_LIMIT = 8;

/**
 * Maximum time (ms) to wait for a single SPARQL query before giving up.
 * Comunica can get stuck on pathological query plans; this prevents
 * one bad query from blocking the entire validation pipeline.
 */
const QUERY_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Wrap a promise with a timeout. Rejects with a TimeoutError if the
 * promise doesn't settle within `ms` milliseconds.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Run an array of async tasks with bounded concurrency.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(limit, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

/**
 * Rewrite a SHACL-SPARQL constraint query to substitute a concrete focus node IRI
 * for $this, avoiding Comunica v5 bugs with variable binding in joins.
 *
 * 1. Locate the outer SELECT clause (before the first WHERE or {)
 * 2. Remove bare $this from the SELECT projection list
 * 3. Keep expressions like (COUNT(?x) AS ?c) and other variables intact
 * 4. Replace $this with the IRI everywhere in the WHERE body
 * 5. If SELECT ends up with no projections, use SELECT *
 */
function rewriteConstraintQuery(query: string, focusIRI: string): string {
  // Find the boundary between the SELECT clause and the WHERE body.
  // We look for "WHERE" preceded by whitespace, or the first "{" that isn't
  // inside a parenthesized expression.
  const whereMatch = query.match(/\bWHERE\s*\{/i);
  const braceMatch = query.match(/\{/);
  let splitIdx: number;
  if (whereMatch && whereMatch.index !== undefined) {
    splitIdx = whereMatch.index;
  } else if (braceMatch && braceMatch.index !== undefined) {
    splitIdx = braceMatch.index;
  } else {
    // Fallback: just replace $this everywhere
    return query.replace(/\$this/g, focusIRI);
  }

  let selectPart = query.substring(0, splitIdx);
  let bodyPart = query.substring(splitIdx);

  // In the SELECT clause, remove bare $this (as a variable projection).
  // Keep expressions like (expr AS ?var) — $this inside them gets replaced with the IRI.
  // First, replace $this inside parenthesized expressions with the IRI
  selectPart = selectPart.replace(/\([^)]*\$this[^)]*\)/g, (expr) =>
    expr.replace(/\$this/g, focusIRI)
  );
  // Then remove bare $this tokens from the projection list
  selectPart = selectPart.replace(/\$this/g, '');

  // Check if the SELECT clause now has no projected variables/expressions.
  // Look for any ?var or (expression) remaining after SELECT [DISTINCT].
  const hasProjections = /(?:SELECT(?:\s+DISTINCT)?)\s+(?:\?|\()/i.test(selectPart);
  if (!hasProjections) {
    // Replace "SELECT [DISTINCT] <whitespace>" with "SELECT [DISTINCT] * "
    selectPart = selectPart.replace(
      /(SELECT(?:\s+DISTINCT)?)\s*/i,
      '$1 * '
    );
  }

  // In the body, replace all $this with the IRI
  bodyPart = bodyPart.replace(/\$this/g, focusIRI);

  return selectPart + bodyPart;
}

/**
 * Validate a single focus node against a single constraint.
 * Returns an array of ValidationResult (0 if no violation, 1+ if violations found).
 */
async function validateFocusNode(
  engine: QueryEngine,
  dataStore: N3.Store,
  constraint: SparqlConstraintInfo,
  focusNode: string,
  extensionFunctions?: Record<string, (args: any[]) => Promise<any>>
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];

  // Completely eliminate $this as a SPARQL variable to avoid multiple
  // Comunica v5 bugs (_Bindings.merge crash, MappingIterator._map crash)
  // that occur when ?this appears in SELECT and/or joins.
  // Strategy: replace $this with the IRI in the WHERE body, and remove
  // bare $this from the SELECT projection (keeping other vars/expressions).
  const focusIRI = `<${focusNode}>`;
  let query = constraint.selectQuery;
  query = rewriteConstraintQuery(query, focusIRI);

  try {
    const queryContext: any = { sources: [dataStore] };
    if (extensionFunctions) {
      queryContext.extensionFunctions = extensionFunctions;
    }
    const bindingsRes = await engine.queryBindings(query, queryContext);
    // Wrap toArray in a Promise that also listens for stream errors,
    // since Comunica may emit errors asynchronously via EventEmitter
    // that bypass the normal Promise rejection chain.
    const rows = await new Promise<any[]>((resolve, reject) => {
      const errorHandler = (err: any) => reject(err);
      bindingsRes.on('error', errorHandler);
      bindingsRes.toArray()
        .then((arr: any[]) => {
          bindingsRes.removeListener('error', errorHandler);
          resolve(arr);
        })
        .catch(reject);
    });

    for (const row of rows) {
      // Per SHACL spec: rows with ?failure bound to true are NOT violations
      const failure = row.get('failure');
      if (failure && failure.value === 'true') continue;

      const pathTerm = row.get('path');
      const valueTerm = row.get('value');
      const messageTerm = row.get('message');

      const message = messageTerm
        ? messageTerm.value
        : constraint.message
          ? substituteMessage(constraint.message, row, focusNode)
          : 'SPARQL constraint violation';

      results.push({
        severity: constraint.severity,
        focusNode: focusNode,
        path: pathTerm ? pathTerm.value : '',
        sourceConstraintComponent: `${SH}SPARQLConstraintComponent`,
        sourceShape: constraint.shapeIri,
        message: message,
        value: valueTerm ? valueTerm.value : '',
      });
    }
  } catch (err: any) {
    results.push({
      severity: constraint.severity,
      focusNode: focusNode,
      path: '',
      sourceConstraintComponent: `${SH}SPARQLConstraintComponent`,
      sourceShape: constraint.shapeIri,
      message: `SPARQL constraint query error: ${err?.message || err}`,
      value: '',
    });
  }

  return results;
}

/**
 * Validate all focus nodes for a single constraint using a SINGLE query.
 *
 * Instead of running one SPARQL query per focus node (which produced 113K+
 * individual queries for QUDT), this runs the constraint query ONCE with
 * $this as a free variable (?this), letting the SPARQL engine find all
 * violations across all resources. Results are then filtered to only include
 * rows where ?this is in the focus node set.
 *
 * This reduces query count from O(focusNodes) to O(1) per constraint.
 * Falls back to per-node validation if the batched query fails.
 */
async function validateConstraint(
  engine: QueryEngine,
  dataStore: N3.Store,
  shapesStore: N3.Store,
  constraint: SparqlConstraintInfo,
  extensionFunctions?: Record<string, (args: any[]) => Promise<any>>,
  focusNodeIRI?: string,
  timeoutMs: number = QUERY_TIMEOUT_MS
): Promise<ValidationResult[]> {
  let focusNodes = findTargetNodes(shapesStore, dataStore, constraint.shapeIri);

  // When scoped to a single focus node, only validate if it's in the target set
  if (focusNodeIRI) {
    if (!focusNodes.includes(focusNodeIRI)) {
      return []; // This constraint doesn't apply to the requested focus node
    }
    focusNodes = [focusNodeIRI];
  }

  // console.log("validateConstraint:", constraint.shapeIri, `(${focusNodes.length} focus nodes)`);

  if (focusNodes.length === 0) return [];

  // If the query doesn't reference $this at all (e.g. FactorUnitShape's
  // sh:SPARQLFunction body which uses ?unit instead), the batched approach
  // can't work — there's no ?this to filter on.  Run the query ONCE and
  // treat every returned row as a violation.  Running it per-node would
  // just repeat the identical query N times since there's nothing to substitute.
  if (!constraint.selectQuery.includes('$this')) {
    // console.log(`  query has no $this — running once for all focus nodes`);
    try {
      const queryContext: any = { sources: [dataStore] };
      if (extensionFunctions) {
        queryContext.extensionFunctions = extensionFunctions;
      }
      const startTime = Date.now();
      const queryLabel = constraint.shapeIri.replace(/.*[/#]/, '');
      const bindingsRes = await withTimeout(
        engine.queryBindings(constraint.selectQuery, queryContext),
        timeoutMs,
        `queryBindings for ${queryLabel} (no-$this)`
      );
      const rows = await withTimeout(
        new Promise<any[]>((resolve, reject) => {
          const errorHandler = (err: any) => reject(err);
          bindingsRes.on('error', errorHandler);
          bindingsRes.toArray()
            .then((arr: any[]) => {
              bindingsRes.removeListener('error', errorHandler);
              resolve(arr);
            })
            .catch(reject);
        }),
        timeoutMs,
        `toArray for ${queryLabel} (no-$this)`
      );
      const elapsed = Date.now() - startTime;
      // console.log(`  no-$this query returned ${rows.length} rows in ${elapsed}ms`);

      const results: ValidationResult[] = [];
      for (const row of rows) {
        const failure = row.get('failure');
        if (failure && failure.value === 'true') continue;

        const pathTerm = row.get('path');
        const valueTerm = row.get('value');
        const messageTerm = row.get('message');

        const message = messageTerm
          ? messageTerm.value
          : constraint.message
            ? constraint.message
            : 'SPARQL constraint violation';

        results.push({
          severity: constraint.severity,
          focusNode: '',
          path: pathTerm ? pathTerm.value : '',
          sourceConstraintComponent: `${SH}SPARQLConstraintComponent`,
          sourceShape: constraint.shapeIri,
          message: message,
          value: valueTerm ? valueTerm.value : '',
        });
      }
      return results;
    } catch (err: any) {
      console.warn(`  no-$this query failed: ${err?.message}`);
      return [];
    }
  }

  // Build focus node set for filtering results
  const focusNodeSet = new Set(focusNodes);

  // Run the constraint query ONCE with $this as a free ?this variable.
  // The query will return violations for ALL matching resources; we filter
  // to only those in the focus node set.
  // GROUP BY clauses that include $this will become GROUP BY ?this, which
  // correctly groups results per focus node.
  const query = constraint.selectQuery.replace(/\$this/g, '?this');
  const startTime = Date.now();
  const queryLabel = constraint.shapeIri.replace(/.*[/#]/, '');

  try {
    const queryContext: any = { sources: [dataStore] };
    if (extensionFunctions) {
      queryContext.extensionFunctions = extensionFunctions;
    }
    const bindingsRes = await withTimeout(
      engine.queryBindings(query, queryContext),
      timeoutMs,
      `queryBindings for ${queryLabel}`
    );
    const rows = await withTimeout(
      new Promise<any[]>((resolve, reject) => {
        const errorHandler = (err: any) => reject(err);
        bindingsRes.on('error', errorHandler);
        bindingsRes.toArray()
          .then((arr: any[]) => {
            bindingsRes.removeListener('error', errorHandler);
            resolve(arr);
          })
          .catch(reject);
      }),
      timeoutMs,
      `toArray for ${queryLabel}`
    );

    const elapsed = Date.now() - startTime;
    // console.log(`  ${queryLabel}: batched query returned ${rows.length} rows in ${elapsed}ms`);

    const results: ValidationResult[] = [];
    for (const row of rows) {
      const thisTerm = row.get('this');
      if (!thisTerm) continue;

      const focusNode = thisTerm.value;
      // Filter: only include results for focus nodes in the target set
      if (!focusNodeSet.has(focusNode)) continue;

      // Per SHACL spec: rows with ?failure bound to true are NOT violations
      const failure = row.get('failure');
      if (failure && failure.value === 'true') continue;

      const pathTerm = row.get('path');
      const valueTerm = row.get('value');
      const messageTerm = row.get('message');

      const message = messageTerm
        ? messageTerm.value
        : constraint.message
          ? substituteMessage(constraint.message, row, focusNode)
          : 'SPARQL constraint violation';

      results.push({
        severity: constraint.severity,
        focusNode: focusNode,
        path: pathTerm ? pathTerm.value : '',
        sourceConstraintComponent: `${SH}SPARQLConstraintComponent`,
        sourceShape: constraint.shapeIri,
        message: message,
        value: valueTerm ? valueTerm.value : '',
      });
    }

    return results;
  } catch (err: any) {
    // Batched query failed or timed out — skip this constraint.
    // Do NOT fall back to per-node (it would be even slower).
    const elapsed = Date.now() - startTime;
    const queryLabel = constraint.shapeIri.replace(/.*[/#]/, '');
    const isTimeout = err?.message?.includes('Timeout');
    const severity = isTimeout ? 'QueryTimeout' : 'QueryError';
    const reason = isTimeout ? 'timed out' : 'failed';
    console.warn(`  ${queryLabel}: batched query ${reason} after ${elapsed}ms (${err?.message}) — skipping`);
    return [{
      severity,
      focusNode: '',
      path: '',
      sourceConstraintComponent: `${SH}SPARQLConstraintComponent`,
      sourceShape: constraint.shapeIri,
      message: `SPARQL constraint ${reason} after ${(elapsed / 1000).toFixed(1)}s: ${queryLabel}${isTimeout ? '' : ' — ' + (err?.message || 'unknown error')}`,
      value: '',
    }];
  }
}

/**
 * Run all sh:sparql constraints from the shapes graph against the data graph.
 * Constraints run in parallel, and within each constraint, focus nodes run
 * with bounded concurrency.
 * When focusNodeIRI is provided, only that node is validated (per-resource mode).
 * When shapeIRI is provided, only constraints belonging to that shape are run.
 * Returns ValidationResult[] for any violations found.
 */
export async function validateSparqlConstraints(
  engine: QueryEngine,
  dataStore: N3.Store,
  shapesStore: N3.Store,
  extensionFunctions?: Record<string, (args: any[]) => Promise<any>>,
  focusNodeIRI?: string,
  shapeIRI?: string,
  queryTimeoutMs?: number
): Promise<ValidationResult[]> {
  const timeoutMs = queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  let constraints = extractSparqlConstraints(shapesStore);

  // When scoped to a single shape, only run constraints owned by that shape
  // (matching shapeIri or constraintIri, since property shape constraints
  // have constraintIri = the property shape blank node but shapeIri = the parent)
  if (shapeIRI) {
    constraints = constraints.filter(c => c.shapeIri === shapeIRI);
    // console.log(`validateSparqlConstraints: filtered to ${constraints.length} constraints for shape ${shapeIRI}`);
  }

  // console.log(`validateSparqlConstraints: ${constraints.length} constraints${focusNodeIRI ? `, scoped to ${focusNodeIRI}` : ''}${shapeIRI ? `, shape ${shapeIRI}` : ''}`);

  // Level 1: Run all constraints in parallel
  const constraintResults = await Promise.all(
    constraints.map(constraint =>
      validateConstraint(engine, dataStore, shapesStore, constraint, extensionFunctions, focusNodeIRI, timeoutMs)
    )
  );

  return constraintResults.flat();
}

/**
 * Resolve sh:target [a sh:SPARQLTarget] by running the SPARQL queries
 * and injecting sh:targetNode triples into a cloned shapes store.
 */
export async function resolveSparqlTargets(
  engine: QueryEngine,
  dataStore: N3.Store,
  shapesStore: N3.Store,
  extensionFunctions?: Record<string, (args: any[]) => Promise<any>>,
  queryTimeoutMs?: number
): Promise<N3.Store> {
  const timeoutMs = queryTimeoutMs ?? QUERY_TIMEOUT_MS;
  const augmented = new N3.Store();
  for (const quad of shapesStore.getQuads(null, null, null, null)) {
    augmented.addQuad(quad);
  }

  const targetQuads = shapesStore.getQuads(null, `${SH}target`, null, null);

  for (const tq of targetQuads) {
    const shapeIri = tq.subject.value;
    const targetNode = tq.object;

    // Only handle sh:SPARQLTarget
    const typeQuads = shapesStore.getQuads(
      targetNode, RDF_TYPE, N3.DataFactory.namedNode(`${SH}SPARQLTarget`), null
    );
    if (typeQuads.length === 0) continue;

    // Get sh:select
    const selectQuads = shapesStore.getQuads(targetNode, `${SH}select`, null, null);
    if (selectQuads.length === 0) continue;

    let selectQuery = selectQuads[0].object.value;

    // Get prefixes from sh:prefixes chain
    const prefixDecls = extractPrefixes(shapesStore, targetNode);
    const prefixString = prefixDecls
      .map(p => `PREFIX ${p.prefix}: <${p.namespace}>`)
      .join('\n');

    const fullQuery = prefixString ? prefixString + '\n' + selectQuery : selectQuery;

    // Normalize $this → ?this
    const query = fullQuery.replace(/\$this/g, '?this');

    try {
      const targetQueryContext: any = { sources: [dataStore] };
      if (extensionFunctions) {
        targetQueryContext.extensionFunctions = extensionFunctions;
      }
      const queryLabel = shapeIri.replace(/.*[/#]/, '');
      const bindingsRes = await withTimeout(
        engine.queryBindings(query, targetQueryContext),
        timeoutMs,
        `queryBindings for SPARQLTarget ${queryLabel}`
      );
      const rows = await withTimeout(
        new Promise<any[]>((resolve, reject) => {
          const errorHandler = (err: any) => reject(err);
          bindingsRes.on('error', errorHandler);
          bindingsRes.toArray()
            .then((arr: any[]) => {
              bindingsRes.removeListener('error', errorHandler);
              resolve(arr);
            })
            .catch(reject);
        }),
        timeoutMs,
        `toArray for SPARQLTarget ${queryLabel}`
      );

      for (const row of rows) {
        const thisNode = row.get('this');
        if (thisNode && thisNode.termType === 'NamedNode') {
          augmented.addQuad(
            N3.DataFactory.namedNode(shapeIri),
            N3.DataFactory.namedNode(`${SH}targetNode`),
            N3.DataFactory.namedNode(thisNode.value)
          );
        }
      }
    } catch (err: any) {
      // Silently skip failed target queries — no targets resolved
    }
  }

  return augmented;
}
