/** Syntax errors, scope errors and type errors, as one list. */
import { DiagnosticSeverity, DiagnosticTag, type Diagnostic } from "vscode-languageserver"
import { applyDirectives, UNUSED_EXPECT_ERROR, UNUSED_EXPECT_WARNING, type Directive } from "@tilua/parser"
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
            severity: d.severity === "warning" ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
            source: "tilua",
            code: "type",
            message: d.message,
        })),
    ]

    // `--@tilua-nocheck`, `--@tilua-ignore`, `--@tilua-expect-error`,
    // `--@tilua-expect-warning`.
    const { kept, unusedExpectErrors, unusedExpectWarnings } = applyDirectives(analysis.directives, semantic,
        d => d.range.start.line + 1, d => d.severity === DiagnosticSeverity.Warning)
    out.push(...kept)
    const unused = (directive: Directive, severity: DiagnosticSeverity, message: string): void => {
        const start = toPosition(directive.line, directive.column)
        out.push({
            range: { start, end: { line: start.line, character: start.character + `--@tilua-${directive.kind}`.length } },
            severity,
            source: "tilua",
            code: "directive",
            message,
        })
    }
    for (const directive of unusedExpectErrors) unused(directive, DiagnosticSeverity.Error, UNUSED_EXPECT_ERROR)
    for (const directive of unusedExpectWarnings) unused(directive, DiagnosticSeverity.Warning, UNUSED_EXPECT_WARNING)

    // Code after a `return`, `break` or `continue` — or a call that never
    // returns — is no error, as in TypeScript: it is shown dimmed.
    for (const { from, to } of analysis.types.unreachable) {
        out.push({
            range: { start: toRange(from).start, end: toRange(to).end },
            severity: DiagnosticSeverity.Hint,
            tags: [DiagnosticTag.Unnecessary],
            source: "tilua",
            code: "unreachable",
            message: "Unreachable code detected",
        })
    }

    return out
}
