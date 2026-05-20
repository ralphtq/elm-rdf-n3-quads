import { Writer } from 'n3';
import jsonld from 'jsonld';
import { PrefixObject, convertArrayToDictionary, jsonTypeAndValueToN3Term, jsonObjectToTerm } from './rdf-utils';

export async function writeQuads(
  prefixObjects: PrefixObject[],
  quads: any[]
): Promise<string> {
  const prefixes = convertArrayToDictionary(prefixObjects);
  const writer = new Writer({
    format: "application/trig",
    prefixes: prefixes,
  });
  const n3Quads = quads.map((quad) => ({
    subject: jsonTypeAndValueToN3Term(quad.subject, prefixes),
    predicate: jsonTypeAndValueToN3Term(quad.predicate, prefixes),
    object: jsonObjectToTerm(quad.object, prefixes),
    graph: jsonTypeAndValueToN3Term(quad.graph, prefixes),
  })) as any;
  writer.addQuads(n3Quads);
  return new Promise<string>((resolve, reject) => {
    writer.end((error, result) => {
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    });
  });
}

export async function writeJSONLD(
  prefixObjects: PrefixObject[],
  quads: any[]
): Promise<string> {
  const prefixes = convertArrayToDictionary(prefixObjects);
  const jsonldDoc = {
    "@context": prefixes,
    "@graph": quads.map((q) => ({
      "@id": q.subject.value,
      [q.predicate.value]: {
        "@id": q.object.value,
      },
    })),
  };
  const expanded = await jsonld.expand(jsonldDoc);
  const compacted = await jsonld.compact(expanded, prefixes);
  return JSON.stringify(compacted, null, 2);
}
