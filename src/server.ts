/**
 * The language server: LSP wiring only.
 *
 * Every handler is the same three steps — get the cached analysis for the
 * document, ask one feature module a question, hand back the answer. The
 * thinking lives in `features/`; nothing here knows about tilua.
 */
import {
    createConnection, DiagnosticSeverity, ProposedFeatures, TextDocuments, TextDocumentSyncKind,
    type Connection, type Diagnostic, type InitializeParams, type InitializeResult, type Position,
} from "vscode-languageserver/node"
import { TextDocument } from "vscode-languageserver-textdocument"
import type { ConfigProblem } from "@tilua/parser"
import { Analyzer, pathOfUri, samePath, uriOfPath, type Analysis, type AnalyzerOptions } from "./analysis.js"
import { importDefinition } from "./features/imports.js"
import { diagnostics } from "./features/diagnostics.js"
import { hover } from "./features/hover.js"
import { definition, references, highlights, prepareRename, rename } from "./features/navigation.js"
import { completion } from "./features/completion.js"
import { signatureHelp } from "./features/signatureHelp.js"
import { documentSymbols } from "./features/symbols.js"
import { semanticTokens, semanticTokensLegend } from "./features/semanticTokens.js"

export interface ServerOptions extends AnalyzerOptions {}

/** How long typing has to stop before the open files are re-checked. Long
 *  enough that a burst of keystrokes costs one sweep rather than one each,
 *  short enough that it still feels immediate once the hands stop. */
const IDLE_MS = 250

/** Attach the tilua language server to a connection. Exported separately from
 *  `startServer` so an editor extension can run it in-process over its own
 *  transport, and so the tests can drive it without spawning anything. */
export function createServer(connection: Connection, options: ServerOptions = {}): void {
    const documents = new TextDocuments(TextDocument)
    // Imports and configs read open documents before disk, so they see
    // unsaved edits.
    const analyzer = new Analyzer({
        ...options,
        openDocument: path => documents.all().find(document => {
            const documentPath = pathOfUri(document.uri)
            return documentPath !== undefined && samePath(documentPath, path)
        }),
    })

    connection.onInitialize((_params: InitializeParams): InitializeResult => ({
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
            definitionProvider: true,
            referencesProvider: true,
            documentHighlightProvider: true,
            documentSymbolProvider: true,
            renameProvider: { prepareProvider: true },
            completionProvider: {
                // `.` and `:` open a member list; the rest of the time
                // completion is asked for as you type a word.
                // plus the characters that start or extend an import path.
                triggerCharacters: [".", ":", "\"", "'", "/"],
                resolveProvider: false,
            },
            signatureHelpProvider: { triggerCharacters: ["(", ","], retriggerCharacters: [","] },
            // Colours from the parser, not from patterns: whether a word is a
            // keyword, a type or a name depends on where it stands.
            semanticTokensProvider: { legend: semanticTokensLegend, full: true },
        },
        serverInfo: { name: "@tilua/language-server" },
    }))

    // --- semantic highlighting ---------------------------------------------
    connection.languages.semanticTokens.on(p => {
        const document = documents.get(p.textDocument.uri)
        return document ? semanticTokens(analyzer.get(document)) : { data: [] }
    })

    // --- diagnostics -------------------------------------------------------
    /** Config files currently showing problems, so fixed ones get cleared. */
    let configUris = new Set<string>()

    const publishAll = (): void => analyzer.sweep(() => {
        const problems = new Map<string, ConfigProblem[]>()
        for (const document of documents.all()) {
            const analysis = analyzer.get(document)
            void connection.sendDiagnostics({
                uri: document.uri,
                version: document.version,
                diagnostics: [...diagnostics(analysis), ...projectHint(analysis)],
            })
            // A problem is shown on the config (or sourcemap) it is about, once
            // however many files share that config.
            for (const problem of analysis.project.problems) {
                const uri = uriOfPath(problem.file)
                const list = problems.get(uri) ?? []
                if (!list.some(p => p.message === problem.message && p.line === problem.line)) list.push(problem)
                problems.set(uri, list)
            }
        }
        for (const [uri, list] of problems) {
            void connection.sendDiagnostics({ uri, diagnostics: list.map(problemDiagnostic) })
        }
        for (const uri of configUris) {
            if (!problems.has(uri)) void connection.sendDiagnostics({ uri, diagnostics: [] })
        }
        configUris = new Set(problems.keys())
    })

    const problemDiagnostic = (problem: ConfigProblem): Diagnostic => {
        const line = Math.max((problem.line ?? 1) - 1, 0)
        const character = Math.max((problem.column ?? 1) - 1, 0)
        // Underline to the end of the line: the option or entry the problem is about.
        const text = analyzer.readFile(problem.file)?.split("\n")[line] ?? ""
        const end = Math.max(text.replace(/\r$/, "").trimEnd().length, character + 1)
        return {
            range: { start: { line, character }, end: { line, character: end } },
            severity: DiagnosticSeverity.Error,
            source: "tilua",
            code: "config",
            message: problem.message,
        }
    }

    /** A file no config covers gets no types at all, which is easy to miss —
     *  so say so, once, at the top of the file. */
    const projectHint = (analysis: Analysis): Diagnostic[] => {
        const { project } = analysis
        if (project.fixed || project.config || !pathOfUri(analysis.uri)) return []
        return [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            severity: DiagnosticSeverity.Information,
            source: "tilua",
            code: "no-config",
            message: "No tilua.config.json applies to this file, so no types are loaded — not even `print`. "
                + "Add one to this folder or a folder above: "
                + "{ \"types\": [], \"paths\": {}, \"sourceMap\": null }, "
                + "listing in `types` the type libraries the project has installed.",
        }]
    }

    // Any change can affect every open file that imports the changed one, or
    // shares its config, so all of them are re-checked; unchanged ones come
    // straight from the cache.
    //
    // Typing is a change per keystroke, and a sweep over every open file costs
    // far more than the gap between two of them — so the sweep waits until the
    // typing stops. Diagnostics a keystroke old are worth nothing anyway: the
    // line is still half-written. Everything else (opening a file, a change on
    // disk) is a single event and runs at once.
    let pending: NodeJS.Timeout | undefined
    const publishSoon = (): void => {
        if (pending) clearTimeout(pending)
        pending = setTimeout(() => {
            pending = undefined
            publishAll()
        }, IDLE_MS)
    }
    const publishNow = (): void => {
        if (pending) clearTimeout(pending)
        pending = undefined
        publishAll()
    }

    documents.onDidOpen(publishNow)
    documents.onDidChangeContent(publishSoon)
    // A module, config, type library or sourcemap changed outside the editor.
    connection.onDidChangeWatchedFiles(publishNow)
    documents.onDidClose(e => {
        analyzer.forget(e.document.uri)
        void connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] })
    })

    // --- language features -------------------------------------------------
    const withDocument = <T>(uri: string, f: (document: TextDocument) => T, fallback: T): T => {
        const document = documents.get(uri)
        return document ? f(document) : fallback
    }

    connection.onHover(p => withDocument(
        p.textDocument.uri, d => hover(analyzer.get(d), p.position), null,
    ))

    // The same hover, at a level the editor asks for. LSP has no way to say
    // "and now tell me more", so an editor that offers that asks here; every
    // other one gets the shortest reading through `onHover` above.
    connection.onRequest("tilua/hover", (p: {
        textDocument: { uri: string }
        position: Position
        depth?: number
    }) => withDocument(
        p.textDocument.uri, d => hover(analyzer.get(d), p.position, Math.max(0, p.depth ?? 0)), null,
    ))

    connection.onDefinition(p => withDocument(
        p.textDocument.uri,
        d => {
            const analysis = analyzer.get(d)
            // Inside an import, the definition is in the other module.
            const across = importDefinition(analyzer, analysis, p.position)
            return across !== undefined ? across : definition(analysis, p.position)
        },
        null,
    ))

    connection.onReferences(p => withDocument(
        p.textDocument.uri,
        d => references(analyzer.get(d), p.position, p.context.includeDeclaration),
        [],
    ))

    connection.onDocumentHighlight(p => withDocument(
        p.textDocument.uri, d => highlights(analyzer.get(d), p.position), [],
    ))

    connection.onDocumentSymbol(p => withDocument(
        p.textDocument.uri, d => documentSymbols(analyzer.get(d)), [],
    ))

    connection.onPrepareRename(p => withDocument(
        p.textDocument.uri,
        d => {
            const prepared = prepareRename(analyzer.get(d), p.position)
            return prepared ? { range: prepared.range, placeholder: prepared.placeholder } : null
        },
        null,
    ))

    connection.onRenameRequest(p => withDocument(
        p.textDocument.uri, d => rename(analyzer.get(d), p.position, p.newName), null,
    ))

    connection.onCompletion(p => withDocument(
        p.textDocument.uri, d => completion(analyzer, d, p.position), [],
    ))

    connection.onSignatureHelp(p => withDocument(
        p.textDocument.uri, d => signatureHelp(analyzer, d, p.position), null,
    ))

    documents.listen(connection)
    connection.listen()
}

/** Run the server over stdio — the transport editors launch it with. */
export function startServer(options: ServerOptions = {}): void {
    createServer(createConnection(ProposedFeatures.all), options)
}
