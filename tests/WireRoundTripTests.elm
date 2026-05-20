module WireRoundTripTests exposing (suite)

{-| Tests for the Rdf.Wire.\* modules.

These tests cover:

  - **Round-trips** — Encode each type to JSON, then Decode it back.
    Verifies that the encoder/decoder pair is consistent.
  - **Fixture decode** — Embeds a hand-authored representative wire blob
    (copied from tests/fixtures/sample-data-model.json, with the
    relevant variants: NamedNode subject, BlankNode subject, literal
    with language, literal with datatype, default-graph marker) and
    asserts that decoding yields the expected structure.

A companion vitest test in this repo asserts the SAME fixture string
serialises identically from the TypeScript side, so wire-format drift
in either ecosystem trips at CI time.

-}

import Expect
import Json.Decode as D
import Json.Encode as E
import Rdf.Wire.Decode as Decode
import Rdf.Wire.Encode as Encode
import Rdf.Wire.Types
    exposing
        ( GraphTicket
        , JSONdataModel
        , JSONrdfObject
        , JSONrdfQuad
        , JSONrdfTermTypeAndValue
        , PrefixObject
        )
import Test exposing (Test, describe, test)



-- SAMPLE VALUES (mirror the fixture exactly)


sampleNamedNode : JSONrdfTermTypeAndValue
sampleNamedNode =
    { termType = "NamedNode"
    , value = "http://example.org/Alice"
    , id = "http://example.org/Alice"
    }


sampleBlankNode : JSONrdfTermTypeAndValue
sampleBlankNode =
    { termType = "BlankNode"
    , value = "_:b0"
    , id = "_:b0"
    }


sampleDefaultGraph : JSONrdfTermTypeAndValue
sampleDefaultGraph =
    { termType = "NamedNode", value = "", id = "" }


samplePredicate : JSONrdfTermTypeAndValue
samplePredicate =
    { termType = "NamedNode"
    , value = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    , id = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    }


sampleNamedObject : JSONrdfObject
sampleNamedObject =
    { termType = "NamedNode"
    , value = "http://example.org/Person"
    , language = Nothing
    , datatype = Nothing
    , id = "http://example.org/Person"
    }


sampleLangLiteral : JSONrdfObject
sampleLangLiteral =
    { termType = "Literal"
    , value = "hello"
    , language = Just "en"
    , datatype =
        Just
            { termType = "NamedNode"
            , value = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
            , id = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString"
            }
    , id = ""
    }


sampleDatatypedLiteral : JSONrdfObject
sampleDatatypedLiteral =
    { termType = "Literal"
    , value = "42"
    , language = Nothing
    , datatype =
        Just
            { termType = "NamedNode"
            , value = "http://www.w3.org/2001/XMLSchema#integer"
            , id = "http://www.w3.org/2001/XMLSchema#integer"
            }
    , id = ""
    }


sampleQuad : JSONrdfQuad
sampleQuad =
    { subject = sampleNamedNode
    , predicate = samplePredicate
    , object = sampleNamedObject
    , graph =
        { termType = "NamedNode"
        , value = "http://example.org/g"
        , id = "http://example.org/g"
        }
    }


sampleTicket : GraphTicket
sampleTicket =
    { baseURI = "http://example.org/g"
    , numberOfQuads = 3
    , imports = [ "http://other.example.org/x" ]
    }


samplePrefixes : List PrefixObject
samplePrefixes =
    [ { prefix = "ex", iri = "http://example.org/" }
    , { prefix = "rdf", iri = "http://www.w3.org/1999/02/22-rdf-syntax-ns#" }
    , { prefix = "rdfs", iri = "http://www.w3.org/2000/01/rdf-schema#" }
    , { prefix = "xsd", iri = "http://www.w3.org/2001/XMLSchema#" }
    ]



-- ROUND-TRIP HELPER


roundTrip :
    (a -> E.Value)
    -> D.Decoder a
    -> a
    -> Result D.Error a
roundTrip enc dec value =
    value
        |> enc
        |> D.decodeValue dec



-- FIXTURE (embedded copy of tests/fixtures/sample-data-model.json)


fixtureJson : String
fixtureJson =
    """
{
  "baseURI": "http://example.org/g",
  "quads": [
    {
      "subject": { "termType": "NamedNode", "value": "http://example.org/Alice", "id": "http://example.org/Alice" },
      "predicate": { "termType": "NamedNode", "value": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", "id": "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" },
      "object": { "termType": "NamedNode", "value": "http://example.org/Person", "language": null, "datatype": null, "id": "http://example.org/Person" },
      "graph": { "termType": "NamedNode", "value": "http://example.org/g", "id": "http://example.org/g" }
    },
    {
      "subject": { "termType": "BlankNode", "value": "_:b0", "id": "_:b0" },
      "predicate": { "termType": "NamedNode", "value": "http://www.w3.org/2000/01/rdf-schema#label", "id": "http://www.w3.org/2000/01/rdf-schema#label" },
      "object": { "termType": "Literal", "value": "hello", "language": "en", "datatype": { "termType": "NamedNode", "value": "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString", "id": "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString" }, "id": "" },
      "graph": { "termType": "NamedNode", "value": "", "id": "" }
    },
    {
      "subject": { "termType": "NamedNode", "value": "http://example.org/Alice", "id": "http://example.org/Alice" },
      "predicate": { "termType": "NamedNode", "value": "http://example.org/age", "id": "http://example.org/age" },
      "object": { "termType": "Literal", "value": "42", "language": null, "datatype": { "termType": "NamedNode", "value": "http://www.w3.org/2001/XMLSchema#integer", "id": "http://www.w3.org/2001/XMLSchema#integer" }, "id": "" },
      "graph": { "termType": "NamedNode", "value": "http://example.org/g", "id": "http://example.org/g" }
    }
  ],
  "prefixes": [
    { "prefix": "ex", "iri": "http://example.org/" },
    { "prefix": "rdf", "iri": "http://www.w3.org/1999/02/22-rdf-syntax-ns#" },
    { "prefix": "rdfs", "iri": "http://www.w3.org/2000/01/rdf-schema#" },
    { "prefix": "xsd", "iri": "http://www.w3.org/2001/XMLSchema#" }
  ]
}
"""



-- TESTS


suite : Test
suite =
    describe "Rdf.Wire"
        [ describe "round-trip Encode → Decode preserves value"
            [ test "JSONrdfTermTypeAndValue (NamedNode)" <|
                \_ ->
                    roundTrip Encode.jsonRdfTermTypeAndValue Decode.jsonRdfTermTypeAndValue sampleNamedNode
                        |> Expect.equal (Ok sampleNamedNode)
            , test "JSONrdfTermTypeAndValue (BlankNode)" <|
                \_ ->
                    roundTrip Encode.jsonRdfTermTypeAndValue Decode.jsonRdfTermTypeAndValue sampleBlankNode
                        |> Expect.equal (Ok sampleBlankNode)
            , test "JSONrdfTermTypeAndValue (default-graph marker)" <|
                \_ ->
                    roundTrip Encode.jsonRdfTermTypeAndValue Decode.jsonRdfTermTypeAndValue sampleDefaultGraph
                        |> Expect.equal (Ok sampleDefaultGraph)
            , test "JSONrdfObject (NamedNode object)" <|
                \_ ->
                    roundTrip Encode.jsonRdfObject Decode.jsonRdfObject sampleNamedObject
                        |> Expect.equal (Ok sampleNamedObject)
            , test "JSONrdfObject (language-tagged literal)" <|
                \_ ->
                    roundTrip Encode.jsonRdfObject Decode.jsonRdfObject sampleLangLiteral
                        |> Expect.equal (Ok sampleLangLiteral)
            , test "JSONrdfObject (datatyped literal)" <|
                \_ ->
                    roundTrip Encode.jsonRdfObject Decode.jsonRdfObject sampleDatatypedLiteral
                        |> Expect.equal (Ok sampleDatatypedLiteral)
            , test "JSONrdfQuad" <|
                \_ ->
                    roundTrip Encode.jsonRdfQuad Decode.jsonRdfQuad sampleQuad
                        |> Expect.equal (Ok sampleQuad)
            , test "GraphTicket" <|
                \_ ->
                    roundTrip Encode.graphTicket Decode.graphTicket sampleTicket
                        |> Expect.equal (Ok sampleTicket)
            , test "JSONdataModel" <|
                \_ ->
                    let
                        model : JSONdataModel
                        model =
                            { baseURI = "http://example.org/g"
                            , quads = [ sampleQuad ]
                            , prefixes = samplePrefixes
                            }
                    in
                    roundTrip Encode.jsonDataModel Decode.jsonDataModel model
                        |> Expect.equal (Ok model)
            ]
        , describe "Fixture decode (cross-language wire-shape check)"
            [ test "sample-data-model.json decodes cleanly" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map .baseURI
                        |> Expect.equal (Ok "http://example.org/g")
            , test "sample fixture yields 3 quads" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map (.quads >> List.length)
                        |> Expect.equal (Ok 3)
            , test "sample fixture yields 4 prefixes" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map (.prefixes >> List.length)
                        |> Expect.equal (Ok 4)
            , test "first quad has NamedNode subject" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map (.quads >> List.head >> Maybe.map (.subject >> .termType))
                        |> Expect.equal (Ok (Just "NamedNode"))
            , test "language-tagged literal decodes Maybe String correctly" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map (.quads >> List.drop 1 >> List.head >> Maybe.map (.object >> .language))
                        |> Expect.equal (Ok (Just (Just "en")))
            , test "datatyped literal decodes datatype reference correctly" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map (.quads >> List.drop 2 >> List.head >> Maybe.andThen (.object >> .datatype) >> Maybe.map .value)
                        |> Expect.equal (Ok (Just "http://www.w3.org/2001/XMLSchema#integer"))
            , test "default-graph quad decodes empty graph value" <|
                \_ ->
                    D.decodeString Decode.jsonDataModel fixtureJson
                        |> Result.map (.quads >> List.drop 1 >> List.head >> Maybe.map (.graph >> .value))
                        |> Expect.equal (Ok (Just ""))
            ]
        ]
