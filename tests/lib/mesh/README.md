# Mesh Library Tests

The tests of `lib/mesh`, a file for each of its modules, and for
`need-route` six more:

- `need-route-subject-words`: the words a cell's declared subjects give it.
- `need-route-subjects`: routing by the subjects cells declare.
- `need-route-service-units`: subjects naming a service unit whole.
- `need-route-ids`: needs found by an id a cell holds, as leg-26.
- `need-route-plain-words`: the words that name no work, left out.
- `need-route-reach`: a need's owner, an ended cell it would reach.

- `support/`: the needs, cells and ties the need-routing tests build.

Many entries because they mirror `lib/mesh` file for file, so a split
here would have to split the library first.
