module Rdf.Wire.Decode exposing
    ( jsonRdfTermTypeAndValue
    , jsonRdfObject
    , jsonRdfQuad
    , jsonDataModel
    , graphTicket
    , prefixObject
    )

{-| `Json.Decode.Decoder`s for every wire-format type in
[`Rdf.Wire.Types`](Rdf-Wire-Types).

Typical usage in an elm-pages app:

    port receiveJSONdataModelV2 : (Json.Decode.Value -> msg) -> Sub msg

    subscriptions : Sub Msg
    subscriptions =
        receiveJSONdataModelV2 <|
            \value ->
                case Json.Decode.decodeValue Rdf.Wire.Decode.jsonDataModel value of
                    Ok payload ->
                        GotDataModel payload

                    Err err ->
                        DataModelDecodeFailed (Json.Decode.errorToString err)

@docs jsonRdfTermTypeAndValue
@docs jsonRdfObject
@docs jsonRdfQuad
@docs jsonDataModel
@docs graphTicket
@docs prefixObject

-}

import Json.Decode as D
import Rdf.Wire.Types
    exposing
        ( GraphTicket
        , JSONdataModel
        , JSONrdfObject
        , JSONrdfQuad
        , JSONrdfTermTypeAndValue
        , PrefixObject
        )


{-| Decoder for `JSONrdfTermTypeAndValue` — the wire shape of a named
node, blank node, or default-graph marker.
-}
jsonRdfTermTypeAndValue : D.Decoder JSONrdfTermTypeAndValue
jsonRdfTermTypeAndValue =
    D.map3 JSONrdfTermTypeAndValue
        (D.field "termType" D.string)
        (D.field "value" D.string)
        (D.field "id" D.string)


{-| Decoder for `JSONrdfObject` — the wire shape of an RDF object term,
including optional `language` and `datatype` for literals.

`language` decodes from JSON `null` or missing field to `Nothing`;
`datatype` likewise.

-}
jsonRdfObject : D.Decoder JSONrdfObject
jsonRdfObject =
    D.map5 JSONrdfObject
        (D.field "termType" D.string)
        (D.field "value" D.string)
        (D.maybe (D.field "language" D.string))
        (D.maybe (D.field "datatype" jsonRdfTermTypeAndValue))
        (D.field "id" D.string)


{-| Decoder for `JSONrdfQuad`.
-}
jsonRdfQuad : D.Decoder JSONrdfQuad
jsonRdfQuad =
    D.map4 JSONrdfQuad
        (D.field "subject" jsonRdfTermTypeAndValue)
        (D.field "predicate" jsonRdfTermTypeAndValue)
        (D.field "object" jsonRdfObject)
        (D.field "graph" jsonRdfTermTypeAndValue)


{-| Decoder for `JSONdataModel` — a SPARQL query response payload.
-}
jsonDataModel : D.Decoder JSONdataModel
jsonDataModel =
    D.map3 JSONdataModel
        (D.field "baseURI" D.string)
        (D.field "quads" (D.list jsonRdfQuad))
        (D.field "prefixes" (D.list prefixObject))


{-| Decoder for `GraphTicket` — sent on `quadStoreUpdated` after a
TTL parse.
-}
graphTicket : D.Decoder GraphTicket
graphTicket =
    D.map3 GraphTicket
        (D.field "baseURI" D.string)
        (D.field "numberOfQuads" D.int)
        (D.field "imports" (D.list D.string))


{-| Decoder for one entry of the TS-side prefix table.
-}
prefixObject : D.Decoder PrefixObject
prefixObject =
    D.map2 PrefixObject
        (D.field "prefix" D.string)
        (D.field "iri" D.string)
