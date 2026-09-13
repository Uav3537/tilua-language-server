# luaut-language-server

Language server (LSP) for **luaut** — the TypeScript-flavoured language that
compiles to Luau. It is a thin layer over [`luaut-parser`][parser]: the parser
does the parsing, scope analysis and flow-sensitive type analysis, and this
package answers editor questions from the tables it produces.

[parser]: https://www.npmjs.com/package/luaut-parser

```bash
npm install luaut-language-server
luaut-language-server --stdio
```

## What it does

| request | notes |
|---|---|
| `publishDiagnostics` | syntax, scope (redeclare, assign-to-`const`) and type errors, on open and on every keystroke. A name nothing declares is an error ("Cannot find name 'x'") whenever type libraries are loaded. `--@luaut-nocheck`, `--@luaut-ignore` and `--@luaut-expect-error` silence scope and type errors |
| `hover` | the type as luaut writes it — the **narrowed** type at a reference, so a guarded `v` reads `string`, not `string \| nil`. Also every name in a type or definitions file: `declare` names (with their overload count), classes (`declare class Part extends BasePart { ...what it adds }`), alias names, object-type properties, type parameters, `infer` names, and any type annotation, which reads as what it resolves to |
| `luaut/hover` | the same hover, at a level the editor asks for (`depth`), and whether there is another (`canExpand`). Level 0 is the shortest true reading — names left as names — and each one opens the names standing a step further in: `const b: Shape`, then `{ kind: "circle", size: number }`, then whatever those are named after. A class stays its name, and a type that names itself opens once. LSP has no way to ask for this, so every other editor gets level 0 through `hover` |
| `semanticTokens` | colours from the parser, not from patterns — see [Highlighting](#highlighting) |
| `definition` | the binding's declaration — and from an `import`, the export in the other module |
| `references`, `documentHighlight` | every use of the binding |
| `rename`, `prepareRename` | refuses names that are not identifiers, and builtins from the definitions files |
| `completion` | members after `.` / `:` (never the globals there), names in scope — including what hoisting makes visible before its declaration: a function declaration anywhere in its block, and every name of the module inside a function body — type names in a type position; inside an `import`, module paths and the exported names. Inside an object literal written against a type — an annotation, `satisfies`, an argument — the keys that type names, minus the ones already there. A name another file of the project exports is offered too, and picking it adds `import { name } from "./path"` at the top (or joins the import of that file already there). With the Roblox types, each service is offered, and picking one adds `const Players = game:GetService("Players")` under the imports and the services already declared |
| `signatureHelp` | every overload, with the active parameter — `:` calls count `self` for you |
| `documentSymbol` | functions, type aliases, top-level bindings |

### Modules

An `import` resolves to a file relative to the importer (`./x`, `../x`; the
extension may be left off, and a folder means its `index.luaut`). That module
is analyzed too, and its exports become the importer's types — so imported
values are type-checked, imported types work in annotations, and a missing
module or export is a diagnostic. Open documents are read before disk, so an
import sees unsaved edits, and a cached result is dropped as soon as anything
it imports changes.

## How it is put together

```
src/
  server.ts       LSP wiring, and nothing else
  analysis.ts     parse -> scopes -> types, cached per document version
  ast-utils.ts    1-based spans <-> 0-based LSP positions, position -> node
  features/       one file per feature; plain functions, no LSP plumbing
```

A feature is `(analysis, position) -> answer`. Nothing in `features/` opens a
connection or knows about documents, which is why `scripts/test.ts` can drive
all of them in-process without spawning a server, and why an editor extension
can call them directly:

```ts
import { Analyzer, hover, diagnostics } from "luaut-language-server"

const analyzer = new Analyzer()               // or { libs: [...] } for your own definitions
const analysis = analyzer.get(document)       // a vscode-languageserver TextDocument
hover(analysis, { line: 3, character: 12 })
diagnostics(analysis)
```

### Speculative parsing

`x.` and `add(1, ` are syntax errors — the text you are in the middle of
typing usually is. Completion and signature help therefore analyze a
*repaired copy* of the document: a placeholder identifier at the cursor for
completion, and the shortest of `nil`, `nil)`, `)` that parses for signature
help. The user's document is never touched and the repaired copy is never
cached.

### Globals

The names a file may use undeclared are not hard-coded: they are read out of
the `declare` statements in the definitions passed to `Analyzer`. Adding a
global to a `.d.luaut` is all it takes for the editor to stop calling it
undefined.

### Highlighting

A word's role in luaut depends on where it stands: `extends` is a keyword in a
type and a name elsewhere, `type Foo = ...` declares an alias while `type(x)`
calls a builtin, `typeof x` in a type is a query while `typeof(v)` in code is a
call. A TextMate grammar only sees characters, so it can only guess — and
guessed `extends (` into a function call.

So `semanticTokens` classifies every token from the same lexer and AST the
analyzer uses: declarations, parameters, properties, methods, types, type
parameters, and soft keywords only where the AST did not claim the word as a
name. The grammar in the editor extension keeps just what characters decide
alone — comments, strings, numbers, reserved words — so a file looks right
before the server answers, and never disagrees with it after.

### Saying more

A hover opens with the shortest thing that is true and says more when asked,
as TypeScript's does. The server answers `luaut/hover` at whatever level it is
given; how the editor offers the next one is the editor's business. The VS
Code extension puts a link under the type, because the hover API that would
draw the buttons is still a proposed one.

## Not yet

- **One file at a time.** No workspace indexing, so no cross-file
  go-to-definition, `workspace/symbol`, or diagnostics for files you have not
  opened.
- **No formatting** — there is no luaut printer yet (the compiler owns
  emitting Luau, and it emits *Luau*, not luaut).
- No code actions, inlay hints, or folding ranges.
- Everything `luaut-parser` does not check is invisible here too: unknown
  properties, writes to `readonly`, generic constraints at call sites,
  metatables.

## Editors

VS Code: [`luaut-vscode`](../luaut-vscode) — a separate project next door. It
bundles this server into the extension, so its `.vsix` is self-contained.

Anything else that speaks LSP: launch `luaut-language-server --stdio` (or
`--node-ipc`) and attach it to the `luaut` language / `.luaut` files.

## Development

```bash
npm run typecheck
npm test          # features in-process, then the built binary over stdio
npm run build
```

`scripts/test.ts` marks the cursor with `‸` in each fixture (not `|` — that is
the union operator). `scripts/e2e.ts` speaks real LSP to `dist/cli.js`.
