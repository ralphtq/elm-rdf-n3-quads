import * as N3 from 'n3';
import { Writer } from 'n3';
import type { Term, BlankNode, Literal } from '@rdfjs/types';

const { namedNode, literal, blankNode } = N3.DataFactory;

export type PrefixObject = { prefix: string; iri: string };

export type TypeAndValue =
  {
    termType: string
    ; value: string
    ; id: string
  };

export function convertArrayToDictionary
  (anArray: Array<{ prefix: string; iri: string }>): Record<string, string> {
  return anArray.reduce((acc, { prefix, iri }) => {
    acc[prefix] = iri;
    return acc;
  }, {} as Record<string, string>);
}

export function shortenIri(
  iri: string,
  prefixes: Record<string, string>
): string {
  if (iri.startsWith("http") || iri.startsWith("urn")) {
    for (const [prefix, ns] of Object.entries(prefixes)) {
      if (iri.startsWith(ns)) {
        return `${prefix}:${iri.slice(ns.length)}`
      }
    }
  }

  return iri
}

export function toCurie(term: Term, prefixes: Record<string, string>): string {
  switch (term.termType) {
    case 'NamedNode': {
      const maybeCurieValue = shortenIri(term.value, prefixes)
      return maybeCurieValue;
    };
    case 'Literal': {
      const maybeCurieValue = shortenIri(term.value, prefixes)
      return maybeCurieValue;
    }
    case 'BlankNode': return `_:${(term as BlankNode).value}`;
    default: return '';
  }
}

export function termToTypeAndValue(term: Term, prefixes: Record<string, string>): TypeAndValue {
  return {
    termType: term.termType,
    value: shortenIri(term.value, prefixes),
    id: toCurie(term, prefixes),
  };
}

export function termToObject(term: Term, prefixes: Record<string, string>) {
  if (term.termType === 'Literal') {
    const lit = term as Literal;
    return {
      termType: 'Literal',
      value: lit.value,
      language: lit.language ? lit.language : null,   // Elm Maybe -> null
      datatype: lit.datatype
        ? {
          termType: lit.datatype.termType         // always NamedNode
          , value: toCurie(lit.datatype, prefixes) // shortenIri(term.value, prefixes) // lit.datatype.value,
          , id: toCurie(lit.datatype, prefixes),
        }
        : null,
      id: '',                                         // literals don't have ids in your schema
    };
  } else {
    const base = termToTypeAndValue(term, prefixes);
    return { ...base, language: null, datatype: null }; // satisfy JSONrdfObject fields
  }
}

export function jsonObjectToTerm(jsonObject: any, prefixes: Record<string, string>): Term {
  switch (jsonObject.termType) {
    case "NamedNode": {
      const maybeCurieValue = shortenIri(jsonObject.value, prefixes)
      return namedNode(maybeCurieValue);
    }

    case "BlankNode": {
      return blankNode(`_:${jsonObject.value}`)
    }

    case "Literal": {
      return literal(jsonObject.value
        , jsonObject.language ? jsonObject.language : jsonObject.datatype ? namedNode(jsonObject.datatype.value) : null
      )
    }

    default: {
      // Ensures exhaustiveness if termType is a union
      throw new Error(`Unknown termType: ${jsonObject.termType}`)
    }
  }
}

export function jsonTypeAndValueToN3Term(typeAndValue: TypeAndValue, prefixes: Record<string, string>): Term {
  switch (typeAndValue.termType) {
    case "NamedNode": {
      const maybeCurieValue = shortenIri(typeAndValue.value, prefixes)
      return namedNode(maybeCurieValue);
    }

    case "BlankNode": {
      return blankNode(`_:${typeAndValue.value}`)
    }

    case "Literal": {
      return literal(typeAndValue.value)
    }

    default: {
      // Ensures exhaustiveness if termType is a union
      throw new Error(`Unknown termType: ${typeAndValue.termType}`)
    }
  }
}

export function allStoredQuads(store: N3.Store) {
  return store.getQuads(null, null, null, null);
}

export function writerToString(writer: Writer): Promise<string> {
  return new Promise((resolve, reject) => {
    writer.end((err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}
