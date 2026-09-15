/**
 * Completion.
 *
 * `x.` and `x:` are syntax errors, so the file as typed cannot answer "what
 * are `x`'s members?". The trick every language server of this shape uses:
 * substitute a placeholder identifier at the cursor, analyze *that* text, and
 * read the answer off the AST it produces. The user's document is untouched —
 * only the speculative copy is analyzed, and it is never cached.
 */
import {
    CompletionItemKind, InsertTextFormat,
    type CompletionItem, type Position,
} from "vscode-languageserver"
import type { TextDocument } from "vscode-languageserver-textdocument"
import { formatType, isClassType, isUnassignedGlobal, type Expression, type Type, type TypeNode } from "@tilua/parser"
import type { Analysis, Analyzer } from "../analysis.js"
import { pathAt, type Spanned } from "../ast-utils.js"
import { importItems, serviceItems } from "./autoImport.js"
import { importCompletion } from "./imports.js"
import { membersOf, signaturesOf, signatureLabel } from "./members.js"

const PLACEHOLDER = "__tiluaCompletion__"
const IDENTIFIER_CHAR = /[A-Za-z0-9_]/

export function completion(
    analyzer: Analyzer,
    document: TextDocument,
    position: Position,
): CompletionItem[] {
    // A module path or imported name: answered from the other module.
    const inImport = importCompletion(analyzer, document, position)
    if (inImport) return inImport

    // Inside a string argument: the values its parameter accepts.
    const inString = stringCompletion(analyzer, document, position)
    if (inString) return inString

    const source = document.getText()
    const offset = document.offsetAt(position)

    // The word being typed, if any — replaced wholesale so a half-written
    // name cannot break the speculative parse.
    let start = offset
    while (start > 0 && IDENTIFIER_CHAR.test(source[start - 1])) start--
    let end = offset
    while (end < source.length && IDENTIFIER_CHAR.test(source[end])) end++

    const operator = memberOperator(source, start)
    const alreadyCalled = /^\s*\(/.test(source.slice(end))

    // A member access on its own is not a statement — `obj.foo` alone on a
    // line is a syntax error, which is exactly where people type `obj.` — so
    // after `.` the placeholder is also tried as a call, which parses wherever
    // the access would and on a line of its own too. A method name after `:`
    // must be called to parse at all.
    const standIns = operator === ":"
        ? [alreadyCalled ? PLACEHOLDER : `${PLACEHOLDER}()`]
        : operator === "." && !alreadyCalled
            ? [PLACEHOLDER, `${PLACEHOLDER}()`]
            : [PLACEHOLDER]

    // Where the placeholder sits, in the patched document's coordinates —
    // the same line, since the patch never spans one.
    const at: Position = { line: position.line, character: position.character - (offset - start) }

    let first: { analysis: Analysis; path: Spanned[] } | undefined
    for (const standIn of standIns) {
        const patched = source.slice(0, start) + standIn + source.slice(end)
        const analysis = analyzer.analyze(document.uri, -1, patched)
        const path = pathAt(analysis.program, at, true)
        const index = path.findLastIndex(
            n => n.type === "Identifier" && (n as unknown as { name: string }).name === PLACEHOLDER,
        )
        const parent = index > 0 ? path[index - 1] : undefined
        if (parent && (parent.type === "MemberExpression" || parent.type === "MethodCallExpression")) {
            return memberItems(analysis, parent)
        }
        first ??= { analysis, path }
    }

    // After `.` or `:` only members make sense. If none could be found, an
    // empty list is honest; the globals are never what was meant there.
    if (operator || !first) return []

    // A key of an object literal written where a type says what belongs in it.
    const keys = objectKeyItems(first.analysis, first.path, source.slice(end))
    if (keys) return keys

    // A type position wants type names, not values.
    if (inTypePosition(first.path)) {
        const named: CompletionItem[] = [...first.analysis.types.aliases].map(([name, type]) => ({
            label: name,
            kind: isClassType(type) ? CompletionItemKind.Class : CompletionItemKind.Interface,
            detail: isClassType(type) ? "class" : "type",
        }))
        const primitives: CompletionItem[] = PRIMITIVES.map(name => ({
            label: name,
            kind: CompletionItemKind.Keyword,
            detail: "type",
        }))
        const keywords: CompletionItem[] = TYPE_KEYWORDS.map(name => ({
            label: name,
            kind: CompletionItemKind.Keyword,
            sortText: `3${name}`,
        }))
        const typeNames = new Set(first.analysis.types.aliases.keys())
        const imported = importItems(analyzer, analyzer.get(document), true, typeNames)
        return [...named, ...primitives, ...keywords, ...imported]
    }

    // Names in scope, then what picking an item can bring into scope: another
    // file's export (with its `import`), or a service (with its `GetService`).
    // Only names the file really has. A name used but never declared is a
    // global binding too, and the half-typed word under the cursor is exactly
    // that — counting it as taken is how a name stopped offering the import
    // that would have defined it.
    const taken = new Set<string>()
    for (const binding of first.analysis.scopes.bindings.values()) {
        if (!isUnassignedGlobal(binding)) taken.add(binding.name)
    }
    const current = analyzer.get(document)
    return [
        ...valueItems(first.analysis, at, insideFunction(first.path)),
        ...contextKeywords(source.slice(0, start)),
        ...importItems(analyzer, current, false, taken),
        ...serviceItems(current, taken),
    ]
}

/** Completion inside a string literal, or `undefined` when the cursor is not
 *  in one. A string that is a call argument offers the string values its
 *  parameter accepts — `game:GetService("|")` lists the services. Any other
 *  string offers nothing: a variable name is never what goes inside quotes. */
function stringCompletion(
    analyzer: Analyzer,
    document: TextDocument,
    position: Position,
): CompletionItem[] | undefined {
    let analysis = analyzer.get(document)
    let literal = stringAt(analysis, position)
    if (!literal) {
        // Mid-typing, the line around the string rarely parses yet —
        // `if name == "` has neither its closing quote nor its `then`. Try the
        // likeliest endings on a copy, and read the string from the first
        // that parses. The endings go after the cursor, so positions hold.
        const repaired = repairedStrings(document, position)
        for (const text of repaired) {
            const candidate = analyzer.analyze(document.uri, -1, text)
            literal = stringAt(candidate, position)
            if (literal) {
                analysis = candidate
                break
            }
        }
        if (!literal) return repaired.length ? [] : undefined
    }

    const expected = analysis.types.expectedTypeOf.get(literal as unknown as Expression)
    const values = [...new Set([
        ...stringLiterals(expected, analysis.types.aliases),
        ...indexKeys(analysis, position, literal),
    ])]
    if (!values.length) return []

    // Replace what is between the quotes. A string spanning lines is left to
    // the editor's own filtering.
    const line = literal.line.start - 1
    const range = literal.line.start === literal.line.end
        ? {
            start: { line, character: literal.column.start },
            end: { line, character: literal.column.end - 2 },
        }
        : undefined
    return values.map(value => ({
        label: value,
        kind: CompletionItemKind.Constant,
        ...(range ? { textEdit: { range, newText: value } } : {}),
    }))
}

function stringAt(analysis: Analysis, position: Position): Spanned | undefined {
    const path = pathAt(analysis.program, position, false)
    return [...path].reverse().find(n => n.type === "StringLiteral" || n.type === "TypeLiteralString")
}

/** Inside `{ | }` written against a type — an annotation, `satisfies`, an
 *  argument — the keys that type names, minus the ones already written. */
function objectKeyItems(
    analysis: Analysis,
    path: readonly Spanned[],
    after: string,
): CompletionItem[] | undefined {
    const index = path.findLastIndex(
        n => n.type === "Identifier" && (n as unknown as { name: string }).name === PLACEHOLDER,
    )
    const literal = index > 0 ? (path[index - 1] as unknown as Record<string, unknown>) : undefined
    if (literal?.type !== "TableExpression") return undefined
    const fields = literal.fields as { type: string; key?: { name?: string; value?: string }; name?: { name: string } }[]
    // Only where a key is being written: `{ width: | }` is a value.
    const atKey = fields.some(f => f.type === "TableFieldShorthand" && f.name?.name === PLACEHOLDER)
    if (!atKey) return undefined
    // `{ ... } as const satisfies T` records the expectation on the whole
    // `as const`, so read through the wrappers the literal sits in.
    let expected = analysis.types.expectedTypeOf.get(literal as unknown as Expression)
    for (let up = index - 2; expected === undefined && up >= 0; up--) {
        const outer = path[up]
        if (outer.type !== "AsConstExpression" && outer.type !== "ParenthesizedExpression") break
        expected = analysis.types.expectedTypeOf.get(outer as unknown as Expression)
    }
    const members = membersOf(expected, analysis.types.aliases)
    if (!members.length) return undefined

    const written = new Set<string>()
    for (const field of fields) {
        if (field.type === "TableFieldNamed") written.add(field.key?.name ?? field.key?.value ?? "")
        else if (field.type === "TableFieldShorthand" && field.name?.name !== PLACEHOLDER) written.add(field.name!.name)
    }
    // `name: ` unless the line already has the colon.
    const colon = /^\s*:/.test(after)
    return members
        .filter(member => !written.has(member.name))
        .map(member => ({
            label: member.name,
            kind: CompletionItemKind.Field,
            detail: `${member.property.optional ? "?" : ""}: ${formatType(member.property.type)}`,
            insertText: colon ? member.name : `${member.name}: `,
        }))
}

/** The keys a string can name where it indexes something: `T["|"]` in a type
 *  offers `T`'s property names, and `obj["|"]` those of `obj`'s type. */
function indexKeys(analysis: Analysis, position: Position, literal: Spanned): string[] {
    const path = pathAt(analysis.program, position, false)
    const at = path.indexOf(literal)
    const parent = at > 0 ? (path[at - 1] as unknown as Record<string, unknown>) : undefined
    if (!parent) return []
    let indexed: Type | undefined
    if (parent.type === "IndexedAccessTypeNode" && parent.indexType === literal) {
        indexed = analysis.types.typeOfTypeNode.get(parent.objectType as TypeNode)
    } else if (parent.type === "IndexExpression" && parent.index === literal) {
        indexed = withoutNil(analysis.types.typeOf.get(parent.object as Expression))
    }
    return membersOf(indexed, analysis.types.aliases).map(member => member.name)
}

/** Copies of the document where the string the cursor is in — possibly
 *  unclosed — could parse: its quote closed if need be, and the line finished
 *  as an `if`, a loop or a call would be. Empty when the cursor is not inside
 *  quotes at all. */
function repairedStrings(document: TextDocument, position: Position): string[] {
    const source = document.getText()
    const offset = document.offsetAt(position)
    const lineStart = offset - position.character
    const lineEndIndex = source.indexOf("\n", offset)
    const lineEnd = lineEndIndex < 0 ? source.length : lineEndIndex
    const before = source.slice(lineStart, offset)

    // Which quote, if any, the cursor is inside.
    let quote: string | undefined
    for (let i = 0; i < before.length; i++) {
        const ch = before[i]
        if (quote) {
            if (ch === "\\") i++
            else if (ch === quote) quote = undefined
        } else if (ch === '"' || ch === "'") {
            quote = ch
        }
    }
    if (!quote) return []

    let rest = source.slice(offset, lineEnd).replace(/\r$/, "")
    if (!rest.includes(quote)) rest += quote
    const line = before + rest
    const endings = ["", " then end", " do end", ")", ") then end", "]"]
    return endings.map(ending => source.slice(0, lineStart) + line + ending + source.slice(lineEnd))
}

/** The string literal types a type admits — through unions, aliases and a
 *  type parameter's constraint. */
function stringLiterals(type: Type | undefined, aliases: ReadonlyMap<string, Type>, seen = new Set<Type>()): string[] {
    if (!type || seen.has(type)) return []
    seen.add(type)
    switch (type.kind) {
        case "literal":
            return typeof type.value === "string" ? [type.value] : []
        case "union":
            return [...new Set(type.types.flatMap(t => stringLiterals(t, aliases, seen)))]
        case "genericRef": {
            const alias = aliases.get(type.name)
            return alias ? stringLiterals(alias, aliases, seen) : []
        }
        case "typeParam":
            return stringLiterals(type.constraint, aliases, seen)
        default:
            return []
    }
}

/** The member operator right before the word being typed, if there is one.
 *  `..` is concatenation and `1.` is a number, neither of which has members. */
function memberOperator(source: string, wordStart: number): "." | ":" | undefined {
    const ch = source[wordStart - 1]
    if (ch === ":") return source[wordStart - 2] === ":" ? undefined : ":"
    if (ch !== ".") return undefined
    if (source[wordStart - 2] === ".") return undefined
    // A run of digits right before the dot, not part of a longer name.
    let i = wordStart - 2
    while (i >= 0 && /[0-9]/.test(source[i])) i--
    const digits = wordStart - 2 - i
    if (digits > 0 && (i < 0 || !/[A-Za-z_]/.test(source[i]))) return undefined
    return "."
}

function memberItems(analysis: Analysis, access: Spanned): CompletionItem[] {
    const object = (access as unknown as { object: Expression }).object
    // `a?.` reads from `a` when it is not nil, and so, in practice, does `a.`
    // on a `T | nil` a check has not narrowed yet: offer what `T` has.
    const type = withoutNil(analysis.types.typeOf.get(object))
    const colon = access.type === "MethodCallExpression"

    // An array and a string have no fields of their own: what they answer to
    // is the language's own methods, and only with `:`. `names.filter` would
    // be a read of a key the table does not have.
    if (isMethodOnly(type) && !colon) return []

    return membersOf(type, analysis.types.aliases)
        .filter(member => (colon ? member.isMethod : true))
        .map(member => memberItem(member.name, member.property.type, member.property.readonly))
}

function withoutNil(type: Type | undefined): Type | undefined {
    if (type?.kind !== "union") return type
    const kept = type.types.filter(t => !(t.kind === "primitive" && t.name === "nil"))
    return kept.length === 1 ? kept[0] : { ...type, types: kept }
}

/** A value whose members are all methods the language gives it — an array or
 *  a string — rather than fields of its own. */
function isMethodOnly(type: Type | undefined): boolean {
    if (!type) return false
    switch (type.kind) {
        case "array":
        case "tuple":
        case "templateLiteral":
            return true
        case "primitive": return type.name === "string"
        case "literal": return typeof type.value === "string"
        case "union": return type.types.length > 0 && type.types.every(isMethodOnly)
        default: return false
    }
}

/** Is the cursor inside a function body? Code there runs after the module
 *  has, so it sees the module's later names — which is why completion offers
 *  them there and not in a statement that runs straight away. */
function insideFunction(path: readonly Spanned[]): boolean {
    return path.some(n => n.type === "FunctionExpression" || n.type === "FunctionDeclaration"
        || n.type === "FunctionDeclarationStatement" || n.type === "FunctionBody")
}

/** Names in scope at `at`. Scope analysis records where each binding is
 *  declared but not the extent of its scope, so this approximates: everything
 *  declared earlier in the file, plus what hoisting makes visible before its
 *  declaration — a function declaration anywhere, and any later name to code
 *  inside a function body — plus the globals, which are visible everywhere.
 *  Over-offering is the right failure: a name the editor lists and the file
 *  rejects is a diagnostic away from being obvious. */
function valueItems(analysis: Analysis, at: Position, inFunction: boolean): CompletionItem[] {
    const items: CompletionItem[] = []
    const seen = new Set<string>()
    for (const binding of analysis.scopes.bindings.values()) {
        if (binding.name === PLACEHOLDER || seen.has(binding.name)) continue
        // `import type` names are not values.
        if (binding.declaredBy === "type") continue
        const declaration = binding.declarationNode as unknown as Spanned | undefined
        const later = declaration !== undefined && declaration.line.start - 1 > at.line
        // A function declaration is visible to its whole block, and everything
        // a module declares is visible to code that runs later.
        if (later && !inFunction && binding.declaredBy !== "function") continue
        seen.add(binding.name)
        const type = analysis.types.bindingType.get(binding.id)
        items.push({
            label: binding.name,
            kind: kindOf(type, binding.kind),
            detail: type ? formatType(type) : undefined,
            // Locals before globals, and globals before library names.
            sortText: `${binding.isBuiltin ? 2 : binding.kind === "global" ? 1 : 0}${binding.name}`,
        })
    }
    for (const keyword of KEYWORDS) {
        items.push({ label: keyword, kind: CompletionItemKind.Keyword, sortText: `3${keyword}` })
    }
    return items
}

function memberItem(name: string, type: Type, readonly?: boolean): CompletionItem {
    const signatures = signaturesOf(type)
    if (signatures.length) {
        return {
            label: name,
            kind: CompletionItemKind.Method,
            detail: signatureLabel(signatures[0]).label,
            insertText: `${name}($0)`,
            insertTextFormat: InsertTextFormat.Snippet,
        }
    }
    return {
        label: name,
        kind: CompletionItemKind.Field,
        detail: `${readonly ? "readonly " : ""}${formatType(type)}`,
    }
}

function kindOf(type: Type | undefined, bindingKind: string): CompletionItemKind {
    if (type && signaturesOf(type).length) return CompletionItemKind.Function
    if (bindingKind === "param" || bindingKind === "self") return CompletionItemKind.Variable
    return CompletionItemKind.Variable
}

/** Is the cursor inside a type annotation? Every type node's name ends in
 *  `TypeNode`, plus the couple that do not. */
function inTypePosition(path: readonly Spanned[]): boolean {
    return path.some(n =>
        !!n.type && (n.type.endsWith("TypeNode") || n.type === "TypeReference"
            || n.type === "TypeAliasStatement" || n.type === "ExportTypeAliasStatement"
            || n.type === "DeclareClassStatement"),
    )
}

const PRIMITIVES = [
    "any", "unknown", "never", "nil", "boolean", "number", "string", "thread", "buffer",
]

/** Keywords only a type position can hold. */
const TYPE_KEYWORDS = ["keyof", "typeof", "infer", "extends"]

/** Keywords that only follow something particular: `as` / `satisfies` an
 *  expression, `extends` a type parameter's name. Offered only there, so
 *  ordinary code is not littered with them. */
function contextKeywords(before: string): CompletionItem[] {
    const keyword = (name: string): CompletionItem => ({
        label: name,
        kind: CompletionItemKind.Keyword,
        sortText: `3${name}`,
    })
    // `function f<K |`, `type Box<T |`
    if (/<\s*[A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*\s+$/.test(before)) return [keyword("extends")]
    // Something an expression can end with, on this line: `x |`, `f() |`.
    if (/[)\]}"'`\w][^\S\n]+$/.test(before)) return [keyword("as"), keyword("satisfies")]
    return []
}

const KEYWORDS = [
    "const", "let", "function", "return", "if", "then", "elseif", "else", "end",
    "for", "in", "while", "do", "repeat", "until", "break", "continue",
    "type", "declare", "export", "import", "and", "or", "not", "true", "false", "nil",
]
