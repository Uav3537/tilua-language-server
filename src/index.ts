/**
 * @tilua/language-server — LSP front end for tilua, built on `@tilua/parser`.
 *
 * The usual way in is `startServer()` (or the `@tilua/language-server` binary).
 * The feature functions are exported too: they are plain
 * `(analysis, position) -> answer` functions with no LSP plumbing, so an
 * editor extension can call them directly in-process.
 */
export { createServer, startServer, type ServerOptions } from "./server.js"
export { Analyzer, pathOfUri, uriOfPath, samePath, type Analysis, type AnalyzerOptions } from "./analysis.js"
export { importCompletion, importDefinition, exportDeclaration } from "./features/imports.js"

export { diagnostics } from "./features/diagnostics.js"
export { hover } from "./features/hover.js"
export {
    definition, references, highlights, prepareRename, rename, bindingAt,
} from "./features/navigation.js"
export { completion } from "./features/completion.js"
export { signatureHelp } from "./features/signatureHelp.js"
export { documentSymbols } from "./features/symbols.js"
export { semanticTokens, semanticTokensLegend } from "./features/semanticTokens.js"
export { membersOf, signaturesOf, signatureLabel, type Member } from "./features/members.js"

export {
    toRange, toPosition, containsPosition, pathAt, nodeAt, enclosing, walk, children,
    type Spanned,
} from "./ast-utils.js"
