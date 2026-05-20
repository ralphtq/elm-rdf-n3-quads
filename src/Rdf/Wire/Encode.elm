module Rdf.Wire.Encode exposing
    ( jsonRdfTermTypeAndValue
    , jsonRdfObject
    , jsonRdfQuad
    , jsonDataModel
    , graphTicket
    , prefixObject
    )

{-| `Json.Encode` constructors for every wire-format type in
[`Rdf.Wire.Types`](Rdf-Wire-Types). Use these when the Elm side needs
to construct a wire value to send back to the TypeScript companion via
a port — for example, to ship a list of `JSONrdfQuad`s to `writeQuads`
or `shaclValidateWithQuads`.

@docs jsonRdfTermTypeAndValue
@docs jsonRdfObject
@docs jsonRdfQuad
@docs jsonDataModel
@docs graphTicket
@docs prefixObject

-}

import Json.Encode as E
import Rdf.Wire.Types
    exposing
        ( GraphTicket
        , JSONdataModel
        , JSONrdfObject
        , JSONrdfQuad
        , JSONrdfTermTypeAndValue
        , PrefixObject
        )


{-| Encode a `JSONrdfTermTypeAndValue`.
-}
jsonRdfTermTypeAndValue : JSONrdfTermTypeAndValue -> E.Value
jsonRdfTermTypeAndValue term =
    E.object
        [ ( "termType", E.string term.termType )
        , ( "value", E.string term.value )
        , ( "id", E.string term.id )
        ]


{-| Encode a `JSONrdfObject`. `language` and `datatype` are emitted as
JSON `null` when `Nothing`.
-}
jsonRdfObject : JSONrdfObject -> E.Value
jsonRdfObject obj =
    E.object
        [ ( "termType", E.string obj.termType )
        , ( "value", E.string obj.value )
        , ( "language", maybeString obj.language )
        , ( "datatype"
          , case obj.datatype of
                Just dt ->
                    jsonRdfTermTypeAndValue dt

                Nothing ->
                    E.null
          )
        , ( "id", E.string obj.id )
        ]


{-| Encode a `JSONrdfQuad`.
-}
jsonRdfQuad : JSONrdfQuad -> E.Value
jsonRdfQuad quad =
    E.object
        [ ( "subject", jsonRdfTermTypeAndValue quad.subject )
        , ( "predicate", jsonRdfTermTypeAndValue quad.predicate )
        , ( "object", jsonRdfObject quad.object )
        , ( "graph", jsonRdfTermTypeAndValue quad.graph )
        ]


{-| Encode a `JSONdataModel`.
-}
jsonDataModel : JSONdataModel -> E.Value
jsonDataModel model =
    E.object
        [ ( "baseURI", E.string model.baseURI )
        , ( "quads", E.list jsonRdfQuad model.quads )
        , ( "prefixes", E.list prefixObject model.prefixes )
        ]


{-| Encode a `GraphTicket`.
-}
graphTicket : GraphTicket -> E.Value
graphTicket ticket =
    E.object
        [ ( "baseURI", E.string ticket.baseURI )
        , ( "numberOfQuads", E.int ticket.numberOfQuads )
        , ( "imports", E.list E.string ticket.imports )
        ]


{-| Encode a `PrefixObject`.
-}
prefixObject : PrefixObject -> E.Value
prefixObject p =
    E.object
        [ ( "prefix", E.string p.prefix )
        , ( "iri", E.string p.iri )
        ]


maybeString : Maybe String -> E.Value
maybeString m =
    case m of
        Just s ->
            E.string s

        Nothing ->
            E.null
