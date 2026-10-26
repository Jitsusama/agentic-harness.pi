# lib/core Test Helpers

Helpers only `lib/core`'s tests need: the cases every OAuth callback server
has to pass, and the hooks that let a node child import the package's
TypeScript source. A helper tests elsewhere use too, such as the fake for
running commands or the throwaway git repository, lives once in
`../../support/`.
