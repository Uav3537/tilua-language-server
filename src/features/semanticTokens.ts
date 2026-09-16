/**
 * Semantic highlighting, from the parser rather than from patterns.
 *
 * A TextMate grammar only sees characters, and in tilua a word's role depends
 * on where it stands: `extends` is a keyword inside a type and a plain name
 * elsewhere, `type Foo = ...` declares an alias while `type(x)` calls a
 * builtin, and `typeof x` in a type is a query while `typeof(v)` in code is a
 * call. Guessing that with regexes is how `extends (` came out coloured as a
 * function call. Here every token is classified from the same lexer and AST
 * the analyzer uses, so the colours cannot disagree with what the file means.
 *
 * The grammar still colours what is unambiguous — comments, strings, numbers,
 * reserved words — so the file looks right before the server answers.
 */
import type { SemanticTokens, SemanticTokensLegend } from "vscode-languageserver"
import { tokenize, isClassType, unknownType, type Binding, type Expression, type Identifier, type Token, type Type, type TypeNode } from "@tilua/parser"
import { bindingOfNode, type Analysis } from "../analysis.js"
import { children, type Spanned } from "../ast-utils.js"
import { signaturesOf } from "./members.js"

const TOKEN_TYPES = [
    "namespace", "type", "class", "typeParameter", "parameter", "variable",
    "property", "function", "method", "keyword",
] as const
const TOKEN_MODIFIERS = ["declaration", "readonly", "defaultLibrary", "control"] as const

type TokenType = typeof TOKEN_TYPES[number]
type TokenModifier = typeof TOKEN_MODIFIERS[number]

export const semanticTokensLegend: SemanticTokensLegend = {
    tokenTypes: [...TOKEN_TYPES],
    tokenModifiers: [...TOKEN_MODIFIERS],
}

/** Words the lexer reads as identifiers but the parser treats as keywords
 *  where they stand in the right place. A word is only coloured as one if the
 *  AST did not already claim it as a name. */
const SOFT_KEYWORDS = new Set([
    "type", "declare", "class", "extends", "keyof", "infer", "readonly", "is", "asserts", "satisfies", "typeof",
    "default", "new", "super",
])

/** Soft keywords that belong with `export` / `return` rather than with
 *  `const` / `type`: marked `control`, which the editor extension maps to the
 *  scope themes colour control keywords with. */
const CONTROL_KEYWORDS = new Set(["default"])

const PRIMITIVES = new Set(["any", "unknown", "never", "nil", "boolean", "number", "string", "thread", "buffer"])

interface Entry {
    line: number
    character: number
    length: number
    type: TokenType
    modifiers: readonly TokenModifier[]
}

type Add = (at: { line: { start: number }; column: { start: number } }, length: number,
    type: TokenType, modifiers?: readonly TokenModifier[]) => void

export function semanticTokens(analysis: Analysis): SemanticTokens {
    // Keyed by start position: the first classification of a token wins, so
    // the AST's reading of a word takes precedence over the keyword fallback.
    const entries = new Map<string, Entry>()
    const add: Add = (at, length, type, modifiers = []) => {
        const line = at.line.start - 1
        const character = at.column.start - 1
        const key = `${line}:${character}`
        if (!entries.has(key)) entries.set(key, { line, character, length, type, modifiers })
    }

    let tokens: Token[] = []
    try {
        tokens = tokenize(analysis.source)
    } catch {
        // A lex error: only what the (empty) AST knows gets coloured.
    }
    const identifiers = tokens.filter(t => t.type === "Identifier")

    const ancestors: Spanned[] = []
    const walk = (node: Spanned): void => {
        classify(analysis, node, ancestors, identifiers, add)
        ancestors.push(node)
        for (const child of children(node)) walk(child)
        ancestors.pop()
    }
    walk(analysis.program)

    // Reserved words are left to the grammar: it already tells a control
    // keyword (`if`, `export`) from a declaration keyword (`const`), the way
    // themes colour them. Overriding them with one "keyword" type flattened
    // that. Only soft keywords need the parser's say-so.
    for (const token of tokens) {
        const value = (token as { value?: unknown }).value
        if (token.type !== "Identifier" || typeof value !== "string" || !SOFT_KEYWORDS.has(value)) continue
        add(token, value.length, "keyword", CONTROL_KEYWORDS.has(value) ? ["control"] : [])
    }

    return { data: encode([...entries.values()]) }
}

type AnyNode = Spanned & Record<string, unknown>

function classify(
    analysis: Analysis,
    spanned: Spanned,
    ancestors: readonly Spanned[],
    identifiers: readonly Token[],
    add: Add,
): void {
    const node = spanned as AnyNode
    switch (node.type) {
        case "Identifier":
            identifier(analysis, node, ancestors[ancestors.length - 1] as AnyNode | undefined, add)
            return

        // Declarations whose node starts at the name.
        case "IdentifierPattern":
        case "TypedIdentifier":
        case "FunctionParameter": {
            const name = node.name
            // A destructured parameter has no name; its leaves are patterns.
            if (typeof name !== "string" || !name) return
            const binding = bindingOfNode(analysis, node)
            add(node, name.length, valueKind(analysis, binding), modifiersOf(binding, true))
            return
        }

        // A class body's own words. `public`, `private`, `get`, `set`, `static` and `constructor`
        // are ordinary names anywhere else, so they are coloured from the
        // member they open rather than wherever they are written.
        case "ClassMethod":
        case "ClassField":
        case "ClassAccessor":
        case "ClassConstructor": {
            const opener = node.type === "ClassConstructor" ? "constructor"
                : node.type === "ClassAccessor" ? node.kind as string
                : undefined
            const words = firstTokensWithin(identifiers, node, 3)
            let index = 0
            const accessibility = node.accessibility as string | undefined
            if (accessibility && words[index] && wordOf(words[index]) === accessibility) {
                add(words[index], accessibility.length, "keyword")
                index++
            }
            if (node.isStatic === true && words[index] && wordOf(words[index]) === "static") {
                add(words[index], "static".length, "keyword")
                index++
            }
            if (opener && words[index] && wordOf(words[index]) === opener) {
                add(words[index], opener.length, "keyword")
            }
            return
        }

        case "TypeReference": {
            const base = node.base as string
            const namespace = node.namespace as string | undefined
            const names = firstTokensWithin(identifiers, node, namespace ? 2 : 1)
            if (namespace && names[0]) add(names[0], namespace.length, "namespace")
            const baseToken = names[namespace ? 1 : 0]
            if (!baseToken) return
            if (!namespace && typeParameterInScope(ancestors, base)) {
                add(baseToken, base.length, "typeParameter")
            } else if (isClassType(analysis.types.aliases.get(namespace ? `${namespace}.${base}` : base) ?? unknownType)) {
                add(baseToken, base.length, "class")
            } else {
                add(baseToken, base.length, "type", PRIMITIVES.has(base) ? ["defaultLibrary"] : [])
            }
            return
        }
    }
}

/** How wide a name is *as written*. A quoted key — `{ "key": number }` — is
 *  one `Identifier` whose span takes in the quotes while its `name` does not,
 *  so colouring `name.length` characters from the span's start stopped two
 *  short and left `y"` to the grammar, which painted it as the string it looks
 *  like. Measure the span instead, and fall back to the name for a node that
 *  spans more than its own line. */
function writtenLength(node: AnyNode, name: string): number {
    const line = node.line as { start: number; end: number } | undefined
    const column = node.column as { start: number; end: number } | undefined
    if (!line || !column || line.start !== line.end) return name.length
    const width = column.end - column.start
    return width > 0 ? width : name.length
}

function wordOf(token: Token): string | undefined {
    const value = (token as { value?: unknown }).value
    return typeof value === "string" ? value : undefined
}

function identifier(analysis: Analysis, node: AnyNode, parent: AnyNode | undefined, add: Add): void {
    const name = (node as unknown as Identifier).name
    const as = (type: TokenType, modifiers: readonly TokenModifier[] = []): void =>
        add(node, writtenLength(node, name), type, modifiers)
    const typeOfNode = (n: unknown): Type | undefined => analysis.types.typeOfTypeNode.get(n as TypeNode)

    switch (parent?.type) {
        case "MemberExpression":
            if (parent.property === node) {
                return as(isFunction(analysis.types.typeOf.get(parent as unknown as Expression)) ? "method" : "property")
            }
            break
        case "MethodCallExpression":
            if (parent.method === node) return as("method")
            break
        case "TableExpression":
            if (isFieldKey(parent, node)) return as("property", ["declaration"])
            break
        case "TypeAliasStatement":
        case "ExportTypeAliasStatement":
            if (parent.name === node) return as("type", ["declaration"])
            break
        case "DeclareClassStatement":
            if (parent.name === node) return as("class", ["declaration"])
            break
        case "ClassDeclaration":
            if (parent.name === node) return as("class", ["declaration"])
            if (parent.superclass === node) return as("class")
            break
        case "ClassMethod":
            if (parent.name === node) return as("method", ["declaration"])
            break
        case "ClassField":
            if (parent.name === node) return as("property", ["declaration"])
            break
        case "ClassAccessor":
            if (parent.name === node) return as("property", ["declaration"])
            break
        case "DeclareStatement":
            if (parent.id === node) return as(isFunction(typeOfNode(parent.valueType)) ? "function" : "variable", ["declaration"])
            break
        case "TableTypeProperty":
            if (parent.key === node) {
                return as(
                    isFunction(typeOfNode(parent.valueType)) ? "method" : "property",
                    parent.readonly ? ["declaration", "readonly"] : ["declaration"],
                )
            }
            break
        case "FunctionTypeParameter":
            if (parent.id === node) return as("parameter", ["declaration"])
            break
        case "GenericTypeParameter":
        case "InferTypeNode":
            if (parent.id === node) return as("typeParameter", ["declaration"])
            break
        case "MappedTypeNode":
            if (parent.parameterId === node) return as("typeParameter", ["declaration"])
            break
        case "ImportSpecifier": {
            // A type-only import is a type, not an `any` value.
            const binding = bindingOfNode(analysis, node)
            if (binding?.declaredBy === "type") return as("type", ["declaration"])
            const value = binding && analysis.types.bindingType.get(binding.id)
            if (analysis.types.aliases.has(name) && (!value || value.kind === "any")) return as("type", ["declaration"])
            break
        }
        case "ImportStatement":
            // `import * as Module`
            if (parent.namespaceImport === node) return as("namespace", ["declaration"])
            break
        case "ExportSpecifier":
            // `export { Size }` can name a type, which has no value binding.
            if (!bindingOfNode(analysis, node) && analysis.types.aliases.has(name)) return as("type")
            break
        case "FunctionName":
            // `function a.b.c:d()` — `a` is a variable, `b`/`c` are properties,
            // `d` is the method being defined.
            if ((parent.path as unknown[]).includes(node)) return as("property")
            if (parent.method === node) return as("method", ["declaration"])
            break
    }

    const binding = bindingOfNode(analysis, node)
    // No binding: a name the analysis has no reading of (inside a syntax
    // error, say). Leave it to the grammar rather than guess.
    if (!binding) return
    as(valueKind(analysis, binding), modifiersOf(binding, binding.declarationNode === (node as unknown)))
}

function valueKind(analysis: Analysis, binding: Binding | undefined): TokenType {
    if (!binding) return "variable"
    if (binding.kind === "param" || binding.kind === "self") return "parameter"
    if (binding.declaredBy === "namespace") return "namespace"
    return isFunction(analysis.types.bindingType.get(binding.id)) ? "function" : "variable"
}

function modifiersOf(binding: Binding | undefined, isDeclaration: boolean): TokenModifier[] {
    const modifiers: TokenModifier[] = []
    if (isDeclaration) modifiers.push("declaration")
    if (binding?.isConst) modifiers.push("readonly")
    if (binding?.isBuiltin) modifiers.push("defaultLibrary")
    return modifiers
}

function isFunction(type: Type | undefined): boolean {
    return signaturesOf(type).length > 0
}

function isFieldKey(table: AnyNode, key: AnyNode): boolean {
    const fields = table.fields as { type: string; key?: unknown }[]
    return fields.some(f => f.type === "TableFieldNamed" && f.key === key)
}

/** Is `name` a type parameter at this point — declared by an enclosing
 *  generic list, a mapped type's key, or an `infer` in a conditional? */
function typeParameterInScope(ancestors: readonly Spanned[], name: string): boolean {
    for (let i = ancestors.length - 1; i >= 0; i--) {
        const a = ancestors[i] as AnyNode
        if ((a.generics as { name: string }[] | undefined)?.some(g => g.name === name)) return true
        if (a.type === "MappedTypeNode" && a.parameter === name) return true
        if (a.type === "ConditionalTypeNode" && bindsInfer(a.extendsType, name)) return true
    }
    return false
}

function bindsInfer(node: unknown, name: string): boolean {
    if (!node || typeof node !== "object") return false
    if (Array.isArray(node)) return node.some(n => bindsInfer(n, name))
    const n = node as AnyNode
    if (n.type === "InferTypeNode" && n.name === name) return true
    return Object.values(n).some(v => bindsInfer(v, name))
}

/** The first `count` identifier tokens inside `node`'s span. Tokens are in
 *  source order, so binary search to the start and read forward. */
function firstTokensWithin(tokens: readonly Token[], node: Spanned, count: number): Token[] {
    let lo = 0
    let hi = tokens.length
    while (lo < hi) {
        const mid = (lo + hi) >> 1
        const t = tokens[mid]
        const before = t.line.start < node.line.start
            || (t.line.start === node.line.start && t.column.start < node.column.start)
        if (before) lo = mid + 1
        else hi = mid
    }
    const out: Token[] = []
    for (let i = lo; i < tokens.length && out.length < count; i++) {
        const t = tokens[i]
        const after = t.line.start > node.line.end
            || (t.line.start === node.line.end && t.column.start >= node.column.end)
        if (after) break
        out.push(t)
    }
    return out
}

/** LSP's relative encoding: each token as five integers relative to the
 *  previous one. */
function encode(entries: Entry[]): number[] {
    entries.sort((a, b) => a.line - b.line || a.character - b.character)
    const data: number[] = []
    let line = 0
    let character = 0
    for (const e of entries) {
        const deltaLine = e.line - line
        data.push(
            deltaLine,
            deltaLine === 0 ? e.character - character : e.character,
            e.length,
            TOKEN_TYPES.indexOf(e.type),
            e.modifiers.reduce((bits, m) => bits | (1 << TOKEN_MODIFIERS.indexOf(m)), 0),
        )
        line = e.line
        character = e.character
    }
    return data
}
