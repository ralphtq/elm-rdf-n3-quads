module Rdf.Wire.Types exposing
    ( IRI, Prefix, BaseURI, GraphId, TermId
    , JSONrdfTermTypeAndValue
    , JSONrdfObject
    , JSONrdfQuad
    , JSONdataModel
    , GraphTicket
    , PrefixObject
    )

{-| Type aliases for the JSON wire format produced and consumed by the
[@ralphtq/elm-rdf-n3-quads](https://github.com/ralphtq/elm-rdf-n3-quads)
TypeScript companion. Use [`Rdf.Wire.Decode`](Rdf-Wire-Decode) to decode JSON
arriving via an Elm port, and [`Rdf.Wire.Encode`](Rdf-Wire-Encode) to construct
the same shapes from Elm to send back through a port.

This module is intentionally minimal. It defines only the wire-format
types — no higher-level `Quad` or `RDFterm` abstraction. Apps that want
those build them on top, or wait for a future `ralphtq/elm-rdf` package.


# String aliases

@docs IRI, Prefix, BaseURI, GraphId, TermId


# Wire shapes

@docs JSONrdfTermTypeAndValue
@docs JSONrdfObject
@docs JSONrdfQuad
@docs JSONdataModel
@docs GraphTicket
@docs PrefixObject

-}


{-| Any IRI string (e.g. `"http://qudt.org/schema/qudt/Unit"`).
-}
type alias IRI =
    String


{-| A CURIE prefix label (e.g. `"qudt"`).
-}
type alias Prefix =
    String


{-| The base IRI of a named graph.
-}
type alias BaseURI =
    String


{-| Graph identifier — the IRI of a named graph in the quad store.
-}
type alias GraphId =
    String


{-| An RDF resource identifier — IRI or blank node id, depending on context.
-}
type alias TermId =
    String


{-| The wire shape of an RDF term that is either a named node, blank
node, or default-graph marker. Mirrors the TypeScript
`termToTypeAndValue` output:

    { termType = "NamedNode" | "BlankNode" | ""
    , value = "http://example.org/Alice"
    , id = "http://example.org/Alice"
    }

For the default graph, the TS side sends `{ termType = "NamedNode", value = "", id = "" }`.

-}
type alias JSONrdfTermTypeAndValue =
    { termType : String
    , value : String
    , id : String
    }


{-| The wire shape of an RDF object term. Adds `language` and `datatype`
fields for literals. Mirrors the TypeScript `termToObject` output.
-}
type alias JSONrdfObject =
    { termType : String
    , value : String
    , language : Maybe String
    , datatype : Maybe JSONrdfTermTypeAndValue
    , id : String
    }


{-| The wire shape of a complete RDF quad.
-}
type alias JSONrdfQuad =
    { subject : JSONrdfTermTypeAndValue
    , predicate : JSONrdfTermTypeAndValue
    , object : JSONrdfObject
    , graph : JSONrdfTermTypeAndValue
    }


{-| The payload of a SPARQL query response or schema-resources query.
Carries the base URI of the focus graph, the result quads, and the
prefix table the TS side knows about.
-}
type alias JSONdataModel =
    { baseURI : BaseURI
    , quads : List JSONrdfQuad
    , prefixes : List PrefixObject
    }


{-| Sent by the TS side after a TTL parse completes. Tells the Elm side
which graph just landed, how many quads were added, and what
`owl:imports` IRIs the graph declared.
-}
type alias GraphTicket =
    { baseURI : BaseURI
    , numberOfQuads : Int
    , imports : List GraphId
    }


{-| One entry in the TS-side prefix table.
-}
type alias PrefixObject =
    { prefix : Prefix
    , iri : IRI
    }
