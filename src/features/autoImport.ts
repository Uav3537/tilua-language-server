/**
 * Completions that write a line at the top of the file when picked:
 *
 * - a name another file of the project exports adds
 *   `import { name } from "./path"` (or joins an import of that file already
 *   there);
 * - a Roblox service adds `const Players = game:GetService("Players")`.
 *
 * The inserted line is an `additionalTextEdits` of the item, so nothing
 * happens until the item is actually accepted.
 */
import { readdirSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { CompletionItemKind, type CompletionItem, type Position, type TextEdit } from "vscode-languageserver"
import type { ImportStatement, TiluaConfig, Statement } from "@tilua/parser"
import { pathOfUri, samePath, type Analysis, type Analyzer } from "../analysis.js"
import { signaturesOf } from "./members.js"

/** Names exported by the project's other files, as completions that import
 *  them. `taken` are the names already in scope, which need no import. */
export function importItems(
    analyzer: Analyzer,
    analysis: Analysis,
    typePosition: boolean,
    taken: ReadonlySet<string>,
): CompletionItem[] {
    const from = pathOfUri(analysis.uri)
    if (!from) return []
    const config = analysis.project.config
    const items: CompletionItem[] = []
    for (const file of projectFiles(config?.directory ?? dirname(from))) {
        if (samePath(file, from)) continue
        const exports = analyzer.listedExportsAt(file)
        if (!exports || exports.partial) continue
        const names = typePosition ? [...exports.types.keys()] : [...exports.values.keys()]
        const specifier = specifierFor(from, file, config)
        for (const name of names) {
            if (taken.has(name)) continue
            const type = typePosition ? exports.types.get(name)?.type : exports.values.get(name)
            items.push({
                label: name,
                kind: typePosition
                    ? CompletionItemKind.Interface
                    : type && signaturesOf(type).length ? CompletionItemKind.Function : CompletionItemKind.Variable,
                // Two files can export the same name. Both are offered, each
                // saying which file it comes from — picking one for the author
                // would be a guess, and the wrong guess is silent.
                labelDetails: { description: specifier },
                detail: `import { ${name} } from "${specifier}"`,
                // Same name, different file: order by file so the list is
                // stable rather than however the directory was walked.
                sortText: `4${name} ${specifier}`,
                additionalTextEdits: [importEdit(analyzer, analysis, file, name, specifier, typePosition)],
            })
        }
    }
    return items
}

/** Roblox's services, as completions that declare them. */
export function serviceItems(analysis: Analysis, taken: ReadonlySet<string>): CompletionItem[] {
    const services = analysis.types.aliases.get("Services")
    if (!services || services.kind !== "object") return []
    const at = serviceInsertion(analysis.program.body.statements)
    const items: CompletionItem[] = []
    for (const name of services.properties.keys()) {
        if (taken.has(name)) continue
        const line = `const ${name} = game:GetService("${name}")`
        items.push({
            label: name,
            kind: CompletionItemKind.Module,
            labelDetails: { description: "service" },
            detail: line,
            sortText: `5${name}`,
            additionalTextEdits: [{ range: { start: at.position, end: at.position }, newText: `${line}\n${at.gap}` }],
        })
    }
    return items
}

// ---------------------------------------------------------------- edits

function importEdit(
    analyzer: Analyzer,
    analysis: Analysis,
    file: string,
    name: string,
    specifier: string,
    typePosition: boolean,
): TextEdit {
    const statements = analysis.program.body.statements
    const imports = statements.filter((s): s is ImportStatement => s.type === "ImportStatement")

    // Join an import of the same file: `import { a } from "./m"` -> `{ a, name }`.
    const existing = imports.find(s =>
        !s.namespaceImport && (typePosition || !s.isTypeOnly) &&
        samePathOrUndefined(analyzer.resolveModulePath(analysis.uri, s.source.value), file))
    if (existing) {
        const last = existing.specifiers[existing.specifiers.length - 1]
        if (last) {
            const at = endOf(last)
            return { range: { start: at, end: at }, newText: `, ${name}` }
        }
        if (existing.defaultImport) {
            const at = endOf(existing.defaultImport)
            return { range: { start: at, end: at }, newText: `, { ${name} }` }
        }
    }

    // A new line after the last import, or before the first statement.
    const line = `import { ${name} } from "${specifier}"`
    const lastImport = imports[imports.length - 1]
    if (lastImport) {
        const at = { line: lastImport.line.end, character: 0 }
        return { range: { start: at, end: at }, newText: `${line}\n` }
    }
    const first = statements[0]
    const at = { line: first ? first.line.start - 1 : 0, character: 0 }
    return { range: { start: at, end: at }, newText: first ? `${line}\n\n` : `${line}\n` }
}

/** Where a service declaration goes: after the imports and the services
 *  already declared at the top, or before the first statement. */
function serviceInsertion(statements: readonly Statement[]): { position: Position; gap: string } {
    let last: Statement | undefined
    for (const statement of statements) {
        if (statement.type !== "ImportStatement" && !isServiceDeclaration(statement)) break
        last = statement
    }
    if (last) return { position: { line: last.line.end, character: 0 }, gap: "" }
    // Nothing declared at the top yet: a blank line before the code.
    const first = statements[0]
    return first
        ? { position: { line: first.line.start - 1, character: 0 }, gap: "\n" }
        : { position: { line: 0, character: 0 }, gap: "" }
}

/** `const X = game:GetService("X")` */
function isServiceDeclaration(statement: Statement): boolean {
    if (statement.type !== "VariableDeclaration") return false
    const init = statement.init
    return init?.type === "MethodCallExpression" && init.method.name === "GetService" &&
        init.object.type === "Identifier" && init.object.name === "game"
}

function endOf(node: { line: { end: number }; column: { end: number } }): Position {
    return { line: node.line.end - 1, character: node.column.end - 1 }
}

function samePathOrUndefined(a: string | undefined, b: string): boolean {
    return a !== undefined && samePath(a, b)
}

// ---------------------------------------------------------------- paths

/** How `from` imports `target`: through a `paths` alias when the relative
 *  path would have to climb out of the folder, else relatively. */
function specifierFor(from: string, target: string, config: TiluaConfig | undefined): string {
    const withoutExtension = (path: string): string => {
        const bare = path.replace(/\\/g, "/").replace(/\.tilua$/, "")
        return bare.endsWith("/index") ? bare.slice(0, -"/index".length) : bare
    }
    let relativePath = withoutExtension(relative(dirname(from), target))
    if (!relativePath.startsWith(".")) relativePath = `./${relativePath}`
    if (!relativePath.startsWith("../") || !config) return relativePath

    for (const [pattern, targets] of Object.entries(config.paths)) {
        const star = pattern.indexOf("*")
        if (star < 0) continue
        for (const targetPattern of targets) {
            const cut = targetPattern.indexOf("*")
            if (cut < 0) continue
            const head = resolve(config.baseUrl, targetPattern.slice(0, cut))
            const rest = relative(head, target)
            if (rest.startsWith("..") || resolve(head, rest) !== resolve(target)) continue
            return `${pattern.slice(0, star)}${withoutExtension(rest)}${pattern.slice(star + 1)}`
        }
    }
    return relativePath
}

const FILE_LIMIT = 2000
const LISTING_TTL = 3000
const listings = new Map<string, { at: number; files: string[] }>()

/** The project's `.tilua` modules — not definitions files, not
 *  `node_modules`, not hidden folders. Listed at most every few seconds. */
function projectFiles(root: string): string[] {
    const cached = listings.get(root)
    if (cached && Date.now() - cached.at < LISTING_TTL) return cached.files
    const files: string[] = []
    const walk = (directory: string, depth: number): void => {
        if (files.length >= FILE_LIMIT || depth > 12) return
        let entries
        try {
            entries = readdirSync(directory, { withFileTypes: true })
        } catch {
            return
        }
        for (const entry of entries) {
            if (entry.name.startsWith(".") || entry.name === "node_modules") continue
            const path = join(directory, entry.name)
            if (entry.isDirectory()) walk(path, depth + 1)
            else if (entry.name.endsWith(".tilua") && !entry.name.endsWith(".d.tilua")) files.push(path)
            if (files.length >= FILE_LIMIT) return
        }
    }
    walk(root, 0)
    listings.set(root, { at: Date.now(), files })
    return files
}
