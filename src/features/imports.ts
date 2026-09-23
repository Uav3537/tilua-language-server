/**
 * Modules, across files: completing module paths and the names they export,
 * and jumping from an `import` (or `export ... from`) to the declaration.
 *
 * Completion works on the line's text rather than the AST — a statement that
 * is being typed does not parse yet, and those are exactly the moments
 * completion is asked for.
 */
import { readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
    CompletionItemKind,
    type Command, type CompletionItem, type Location, type Position, type Range,
} from "vscode-languageserver"
import type { TextDocument } from "vscode-languageserver-textdocument"
import {
    formatType,
    type BindingTarget, type ExportAllStatement, type ExportNamedStatement, type Identifier, type ImportStatement,
} from "@tilua/parser"
import { bindingOfNode, pathOfUri, samePath, uriOfPath, type Analysis, type Analyzer } from "../analysis.js"
import { pathAt, toRange, type Spanned } from "../ast-utils.js"
import { signaturesOf } from "./members.js"

/** Keep the suggestion list open after picking a folder, to go one level in. */
const SUGGEST_AGAIN: Command = { title: "Suggest", command: "editor.action.triggerSuggest" }

/** Completion inside an `import` or `export ... from`, or `undefined` when the
 *  cursor is not in one. */
export function importCompletion(
    analyzer: Analyzer,
    document: TextDocument,
    position: Position,
): CompletionItem[] | undefined {
    const text = document.getText()
    const cursor = document.offsetAt(position)
    const lineStart = document.offsetAt({ line: position.line, character: 0 })
    const lineEnd = document.offsetAt({ line: position.line + 1, character: 0 })
    const before = text.slice(lineStart, cursor)
    const after = text.slice(cursor, lineEnd)
    if (!/^\s*(?:import|export)\b/.test(before)) return undefined

    // In the module path: `from "./sha|"`.
    const path = /\bfrom\s*(["'])([^"']*)$/.exec(before)
    if (path) return pathItems(analyzer, document.uri, position, path[2])

    // In the braces: `import { a, | } from "./x"`.
    const braces = /^\s*(import|export)\s+(?:[A-Za-z_][A-Za-z0-9_]*\s*,\s*)?\{[^}]*$/.exec(before)
    if (braces) {
        const module = /\}\s*from\s*(["'])([^"']+)\1/.exec(after)
        if (module) return nameItems(analyzer, document.uri, module[2], before)
        // `export { | }` with no `from` names this file's own declarations:
        // ordinary completion answers that.
        return braces[1] === "import" ? [] : undefined
    }
    return undefined
}

function pathItems(analyzer: Analyzer, fromUri: string, position: Position, typed: string): CompletionItem[] {
    const from = pathOfUri(fromUri)
    if (!from) return []

    if (typed.startsWith("./") || typed.startsWith("../")) {
        const slash = typed.lastIndexOf("/")
        return entryItems(resolve(dirname(from), typed.slice(0, slash + 1)), rangeBack(position, typed.length - slash - 1), from)
    }

    // Not started yet, or an alias: offer the ways in — `./`, `../` and each
    // `paths` alias — and inside an alias, what its targets hold.
    const items = new Map<string, CompletionItem>()
    const whole = rangeBack(position, typed.length)
    const offer = (label: string, folder: boolean): void => {
        if (!label.startsWith(typed) || label === typed) return
        items.set(label, {
            label,
            kind: folder ? CompletionItemKind.Folder : CompletionItemKind.File,
            textEdit: { range: whole, newText: label },
            command: folder ? SUGGEST_AGAIN : undefined,
        })
    }
    offer("./", true)
    offer("../", true)

    const config = analyzer.projectOf(fromUri).config
    for (const [pattern, targets] of Object.entries(config?.paths ?? {})) {
        const star = pattern.indexOf("*")
        if (star < 0) {
            offer(pattern, false)
            continue
        }
        const prefix = pattern.slice(0, star)
        if (!typed.startsWith(prefix)) {
            offer(prefix, true)
            continue
        }
        const rest = typed.slice(prefix.length)
        const slash = rest.lastIndexOf("/")
        const range = rangeBack(position, rest.length - slash - 1)
        for (const target of targets) {
            const cut = target.indexOf("*")
            const head = cut < 0 ? target : target.slice(0, cut)
            for (const item of entryItems(resolve(config!.baseUrl, head + rest.slice(0, slash + 1)), range, from)) {
                items.set(item.label, item)
            }
        }
    }
    return [...items.values()]
}

/** The tilua files and folders in `directory`, as import path completions. */
function entryItems(directory: string, range: Range, from: string): CompletionItem[] {
    let entries
    try {
        entries = readdirSync(directory, { withFileTypes: true })
    } catch {
        return []
    }

    const items: CompletionItem[] = []
    for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue
        if (entry.isDirectory()) {
            items.push({
                label: `${entry.name}/`,
                kind: CompletionItemKind.Folder,
                textEdit: { range, newText: `${entry.name}/` },
                command: SUGGEST_AGAIN,
            })
        } else if (entry.name.endsWith(".tilua")) {
            // A file does not import itself.
            if (samePath(resolve(directory, entry.name), from)) continue
            const name = entry.name.replace(/(\.d)?\.tilua$/, "")
            items.push({
                label: name,
                kind: CompletionItemKind.File,
                detail: entry.name,
                textEdit: { range, newText: name },
            })
        }
    }
    return items
}

function nameItems(analyzer: Analyzer, fromUri: string, specifier: string, before: string): CompletionItem[] {
    const target = analyzer.resolveModulePath(fromUri, specifier)
    const exports = target ? analyzer.exportsAt(target) : undefined
    if (!exports) return []

    // Names already in the braces are not offered again.
    const braces = before.slice(before.indexOf("{") + 1)
    const listed = new Set(braces.split(",").map(part => part.trim().split(/\s+/)[0]).filter(Boolean))

    const items: CompletionItem[] = []
    for (const [name, type] of exports.values) {
        if (listed.has(name)) continue
        items.push({
            label: name,
            kind: signaturesOf(type).length ? CompletionItemKind.Function : CompletionItemKind.Variable,
            detail: formatType(type),
        })
    }
    for (const [name, exported] of exports.types) {
        if (listed.has(name) || exports.values.has(name)) continue
        items.push({
            label: name,
            kind: CompletionItemKind.Interface,
            detail: `type ${name} = ${formatType(exported.type)}`,
        })
    }
    return items
}

function rangeBack(position: Position, length: number): Range {
    return { start: { line: position.line, character: position.character - length }, end: position }
}

// --------------------------------------------------------------------------
// Definition
// --------------------------------------------------------------------------

/** A statement that names another module. */
type ModuleReference = ImportStatement | ExportNamedStatement | ExportAllStatement

/** Go-to-definition inside a statement that names another module: the module
 *  string opens the module, a name jumps to where it is really declared —
 *  through any `export { } from` and `export *` in between. `undefined` when
 *  the cursor is not in such a statement, so the caller can fall back to
 *  ordinary definition. */
export function importDefinition(
    analyzer: Analyzer,
    analysis: Analysis,
    position: Position,
): Location | null | undefined {
    const path = pathAt(analysis.program, position, true)
    const statement = path.find(isModuleReference) as unknown as ModuleReference | undefined
    if (!statement?.source) return undefined

    const target = analyzer.resolveModulePath(analysis.uri, statement.source.value)
    if (!target) return null
    const fileStart: Location = {
        uri: uriOfPath(target),
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    }

    const name = referencedName(statement, path[path.length - 1] as unknown)
    if (!name) return fileStart
    const module = analyzer.moduleAt(target)
    const found = module && exportDeclaration(analyzer, module, name)
    return found ? { uri: found.uri, range: toRange(found.node) } : fileStart
}

function isModuleReference(node: Spanned): boolean {
    return node.type === "ImportStatement"
        || node.type === "ExportAllStatement"
        || (node.type === "ExportNamedStatement" && !!(node as unknown as ExportNamedStatement).source)
}

/** The name, as the other module exports it, that `node` stands for. */
function referencedName(statement: ModuleReference, node: unknown): string | undefined {
    switch (statement.type) {
        case "ImportStatement":
            if (node === statement.defaultImport) return "default"
            return statement.specifiers.find(s => node === s.imported || node === s.local)?.imported.name
        case "ExportNamedStatement":
            return statement.specifiers.find(s => node === s.local || node === s.exported)?.local.name
        case "ExportAllStatement":
            return undefined
    }
}

export interface Declaration {
    uri: string
    node: Spanned
}

/** Where the export `name` (`"default"` for the default) of `module` is
 *  declared — following re-exports into the module that declares it. */
export function exportDeclaration(
    analyzer: Analyzer,
    module: Analysis,
    name: string,
    seen = new Set<string>(),
): Declaration | undefined {
    // Re-exports can form a cycle; each (module, name) is visited once.
    const key = `${module.uri}#${name}`
    if (seen.has(key)) return undefined
    seen.add(key)

    const here = (node: unknown): Declaration => ({ uri: module.uri, node: node as Spanned })
    const stars: string[] = []

    for (const statement of module.program.body.statements) {
        switch (statement.type) {
            case "ExportDefaultStatement":
                if (name === "default") return here(statement)
                break
            case "ExportTypeAliasStatement":
                if (statement.alias.name.name === name) return here(statement.alias.name)
                break
            case "ExportStatement": {
                const declaration = statement.declaration
                if (declaration.type === "FunctionDeclaration" || declaration.type === "ClassDeclaration") {
                    if (declaration.name.name === name) return here(declaration.name)
                } else {
                    const found = patternNamed(declaration.name, name)
                    if (found) return here(found)
                }
                break
            }
            case "ExportNamedStatement": {
                const specifier = statement.specifiers.find(s => s.exported.name === name)
                if (!specifier) break
                if (statement.source) {
                    const next = moduleFrom(analyzer, module, statement.source.value)
                    return next && exportDeclaration(analyzer, next, specifier.local.name, seen)
                }
                return here(localDeclaration(module, specifier.local) ?? specifier.local)
            }
            case "ExportAllStatement":
                stars.push(statement.source.value)
                break
        }
    }

    // `export *` never carries the default, and a name declared here wins.
    if (name === "default") return undefined
    for (const specifier of stars) {
        const next = moduleFrom(analyzer, module, specifier)
        const found = next && exportDeclaration(analyzer, next, name, seen)
        if (found) return found
    }
    return undefined
}

function moduleFrom(analyzer: Analyzer, module: Analysis, specifier: string): Analysis | undefined {
    const target = analyzer.resolveModulePath(module.uri, specifier)
    return target ? analyzer.moduleAt(target) : undefined
}

/** The declaration of a top-level value or type that `export { x }` names. */
function localDeclaration(module: Analysis, local: Identifier): unknown {
    const binding = bindingOfNode(module, local)
    if (binding?.declarationNode) return binding.declarationNode
    for (const statement of module.program.body.statements) {
        const alias = statement.type === "TypeAliasStatement" ? statement
            : statement.type === "ExportTypeAliasStatement" ? statement.alias
            : undefined
        if (alias?.name.name === local.name) return alias.name
    }
    return undefined
}

function patternNamed(target: BindingTarget, name: string): Spanned | undefined {
    switch (target.type) {
        case "IdentifierPattern":
            return target.name === name ? (target as unknown as Spanned) : undefined
        case "ObjectPattern":
            for (const property of target.properties) {
                const found = patternNamed(property.value, name)
                if (found) return found
            }
            return target.rest && patternNamed(target.rest, name)
        case "ArrayPattern":
            for (const element of target.elements) {
                const found = element && patternNamed(element.value, name)
                if (found) return found
            }
            return target.rest && patternNamed(target.rest, name)
    }
}
