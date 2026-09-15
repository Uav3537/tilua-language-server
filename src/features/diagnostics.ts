/** Syntax errors, scope errors and type errors, as one list. */
import { DiagnosticSeverity, type Diagnostic } from "vscode-languageserver"
import { applyDirectives, UNUSED_EXPECT_ERROR } from "@tilua/parser"
import type { Analysis } from "../analysis.js"
import { toRange, toPosition } from "../ast-utils.js"

export function diagnostics(analysis: Analysis): Diagnostic[] {
    const out: Diagnostic[] = []

    // Syntax errors are always shown: no directive makes broken code compile.
    for (const error of analysis.parseErrors) {
        // A parse error points at a token, not a span; highlight to the end of
        // the word under it so the squiggle is visible.
        const start = toPosition(error.line, error.column)
        out.push({
            range: { start, end: { line: start.line, character: start.character + 1 } },
            severity: DiagnosticSeverity.Error,
            source: "tilua",
            code: "syntax",
            // The parser appends `(line:column)`; the range already says that.
            message: error.message.replace(/\s*\(\d+:\d+\)$/, ""),
        })
    }

    const semantic: Diagnostic[] = [
        ...analysis.scopes.diagnostics.map(d => ({
            range: toRange(d.node),
            severity: DiagnosticSeverity.Error,
            source: "tilua",
            code: d.kind,
            message: d.message,
        })),
        ...analysis.types.diagnostics.map(d => ({
            range: toRange(d.node),
            severity: DiagnosticSeverity.Error,
            source: "tilua",
            code: "type",
            message: d.message,
        })),
    ]

    // `--@tilua-nocheck`, `--@tilua-ignore`, `--@tilua-expect-error`.
    const { kept, unusedExpectErrors } = applyDirectives(analysis.directives, semantic, d => d.range.start.line + 1)
    out.push(...kept)
    for (const directive of unusedExpectErrors) {
        const start = toPosition(directive.line, directive.column)
        out.push({
            range: { start, end: { line: start.line, character: start.character + "--@tilua-expect-error".length } },
            severity: DiagnosticSeverity.Error,
            source: "tilua",
            code: "directive",
            message: UNUSED_EXPECT_ERROR,
        })
    }

    return out
}
