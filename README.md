# @ralphtq/elm-rdf-n3-quads

Port-agnostic TypeScript library for RDF quad-store, SPARQL, and SHACL
validation operations. Wraps [N3.js](https://github.com/rdfjs/N3.js),
[Comunica](https://github.com/comunica/comunica),
[rdf-validate-shacl](https://github.com/zazuko/rdf-validate-shacl),
[sparqljs](https://github.com/RubenVerborgh/SPARQL.js), and
[jsonld.js](https://github.com/digitalbazaar/jsonld.js) behind a single
`QuadStoreSession` class.

Originally extracted from
[elm-qudt](https://github.com/ralphtq/elm-qudt), where it backed the
in-browser RDF quad store via Elm ports. This package is the
port-agnostic core; the companion `@ralphtq/rdf-n3-quads-elm-ports`
shim adapts it for elm-pages / Elm apps.

## Status

Pre-release. `0.1.0` is the first publish; APIs may change before `1.0.0`.

## Install

```sh
npm install @ralphtq/elm-rdf-n3-quads
```

You also need the runtime peers:

```sh
npm install n3 @comunica/query-sparql rdf-validate-shacl sparqljs jsonld jszip
```

## Usage

```ts
import { QuadStoreSession } from '@ralphtq/elm-rdf-n3-quads';

const session = new QuadStoreSession();

const { ticket, dataModel } = await session.parseTTL(turtleContent, baseIRI);
// `ticket` mirrors what Elm consumes via the `quadStoreUpdated` port today;
// `dataModel` is the JSON wire shape used by the elm-pages app.

const results = await session.query('SELECT ?s WHERE { ?s ?p ?o } LIMIT 10');

const turtle = await session.writeTurtle(quads);
const jsonld = await session.writeJSONLD(quads);

const report = await session.validateSHACL({ dataGraphContent, shapesGraphContent });
```

Every method returns a Promise. There is no port awareness, no `app`
parameter, no `app.ports.X.send()` calls anywhere in the package.

## Modules

- `rdf-utils` — term/quad conversion, IRI shortening, CURIE expansion
- `sparql-format` — pretty-print SPARQL via sparqljs
- `rdf-writers` — Turtle (TriG) and JSON-LD serialization
- `n3-parser` — N3/TTL parsing into the session's N3.Store
- `n3-query` — SPARQL execution via Comunica
- `schema-resources-query` — typed-resource discovery
- `shape-parser` — SHACL shape collection parsing
- `shacl-validator` — SHACL validation (JS engine via `rdf-validate-shacl`)
- `sparql-constraint-validator` — `sh:sparql` constraint handling
- `shacl-functions` — SHACL extension functions (`sh:ask`, `sh:select`)
- `zip-catalog` — ZIP file catalog and content extraction
- `inference-runner` — SHACL inference transforms
- `QuadStoreSession` — central façade owning the N3.Store and Comunica QueryEngine

The Jena SHACL bridge lives in a separate package
(`@ralphtq/elm-rdf-jena`, forthcoming) to keep this package
browser-friendly and Node-dep-free.

## Development

```sh
npm install
npm run build      # tsc -> dist/
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

## License

MIT. See [LICENSE](./LICENSE).

## Elm wire-format package

This repo also publishes an Elm package
(`ralphtq/elm-rdf-n3-quads`) that mirrors the JSON wire format the
TypeScript side produces. If you're consuming this package from an
Elm / elm-pages app, the Elm package gives you decoders for the JSON
that arrives over ports — so your Elm code never has to re-derive the
wire shape and drift cannot creep in undetected.

```elm
import Rdf.Wire.Types exposing (JSONdataModel)
import Rdf.Wire.Decode

port receiveJSONdataModelV2 : (Json.Decode.Value -> msg) -> Sub msg

subscriptions =
    receiveJSONdataModelV2 <|
        \value ->
            case Json.Decode.decodeValue Rdf.Wire.Decode.jsonDataModel value of
                Ok payload -> GotDataModel payload
                Err err    -> DecodeFailed (Json.Decode.errorToString err)
```

Install with `elm install ralphtq/elm-rdf-n3-quads` (or copy the
modules directly from this repo until v0.1.0 publishes to the Elm
package registry).

A cross-language fixture (`tests/fixtures/sample-data-model.json`)
serves as the source of truth for the wire shape — both the Elm
test suite (`elm-test`) and the vitest TypeScript suite read it,
so any drift in either ecosystem trips a test in CI.

### Tag conventions

- `0.1.0`, `0.1.1`, ... → Elm package releases (bare semver, per `elm publish`).
- `v0.3.0`, `v0.3.1`, ... → npm package releases (with `v` prefix).

The two tag streams coexist in this repo without colliding.

### Elm development

```sh
npx elm-test                  # run the Elm test suite (tests/*.elm)
npx elm-format --validate src tests
```

