/**
 * Hover: what the thing under the cursor is, as luaut would write it.
 *
 * Every answer comes from the parser's own tables — binding types, the type of
 * each expression, the resolved type of each type annotation — and every name
 * has a node of its own to point at. Nothing is recovered from the source
 * text.
 */
import type { Hover, Position } from "vscode-languageserver"
import {
    formatType, isClassType,
    type Binding, type Expression, type Identifier, type Type, type TypeNode,
} from "luaut-parser"
import { bindingOfNode, type Analysis } from "../analysis.js"
import { pathAt, toRange, type Spanned } from "../ast-utils.js"
import { signaturesOf } from "./members.js"

export function hover(analysis: Analysis, position: Position): Hover | null {
    const path = pathAt(analysis.program, position, true)
    for (let i = path.length - 1; i >= 0; i--) {
        // On an operator, a parenthesis or a dot the cursor is on no name:
        // nothing to say, as in TypeScript — not the type of the whole
        // expression around it.
        if (UNNAMED.has(path[i].type as string)) return null
        const text = describe(analysis, path, i)
        if (text) return { contents: { kind: "markdown", value: code(text) }, range: toRange(path[i]) }
    }
    return null
}

/** Expressions made of other expressions plus operators or punctuation. The
 *  names inside them have hovers of their own. */
const UNNAMED = new Set([
    "BinaryExpression", "UnaryExpression", "CallExpression", "MethodCallExpression",
    "MemberExpression", "IndexExpression", "ParenthesizedExpression", "IfElseExpression",
    "TableExpression", "ArrayExpression", "TypeAssertionExpression", "SatisfiesExpression",
    "AsConstExpression", "InterpolatedStringExpression",
])

type AnyNode = Spanned & Record<string, unknown>

const PRIMITIVES = new Set(["any", "unknown", "never", "nil", "boolean", "number", "string", "thread", "buffer"])

function describe(analysis: Analysis, path: readonly Spanned[], index: number): string | undefined {
    const { types } = analysis
    const node = path[index] as AnyNode
    const parent = path[index - 1] as AnyNode | undefined
    const typeOfNode = (n: unknown): Type | undefined => types.typeOfTypeNode.get(n as TypeNode)

    switch (node.type) {
        case "Identifier": {
            const identifier = node as unknown as Identifier
            const name = identifier.name

            switch (parent?.type) {
                // `{ name: "n" }` — read the property off the object's type, so
                // it widens the way the object did (`string`, not `"n"`).
                case "TableExpression": {
                    const field = fieldWithKey(parent, node)
                    if (!field) break
                    const objectType = types.typeOf.get(parent as unknown as Expression)
                    const property = objectType?.kind === "object" ? objectType.properties.get(name) : undefined
                    const type = property?.type ?? types.typeOf.get(field.value)
                    return type && `(property) ${name}: ${pretty(type)}`
                }
                // `const { name } = t`: a shorthand key *is* the binding it
                // declares, and has the same span, so the cursor can land on
                // either. A renamed key (`{ name: other }`) names the property
                // the value is read from.
                case "ObjectPatternProperty": {
                    if (parent.key !== node || parent.computed) break
                    const value = parent.value as AnyNode
                    if (parent.shorthand) return describe(analysis, [...path.slice(0, index), value], index)
                    const binding = value.type === "IdentifierPattern" ? bindingOfNode(analysis, value) : undefined
                    const type = binding && types.bindingType.get(binding.id)
                    return type && `(property) ${name}: ${pretty(type)}`
                }
                // One line of an overload set reads as its own signature.
                // The line the body is on reads as the whole set, which is
                // what the binding says and what the default path gives.
                case "FunctionSignature": {
                    if (parent.name !== node) break
                    const own = types.typeOfTypeNode.get(parent as unknown as TypeNode)
                    if (own) return `function ${name}${pretty(own)}`
                    break
                }
                case "ImportSpecifier": {
                    // A type-only import has no value worth showing (`any`);
                    // the type it brings in is the answer.
                    const alias = types.aliases.get(name)
                    const binding = bindingOfNode(analysis, identifier)
                    const value = binding && types.bindingType.get(binding.id)
                    if (alias && (!value || value.kind === "any")) return `type ${name} = ${pretty(alias)}`
                    break
                }
                case "ExportSpecifier": {
                    // `export { Size }` can name a type, which has no binding.
                    if (bindingOfNode(analysis, identifier)) break
                    const alias = types.aliases.get(name)
                    if (alias) return `type ${name} = ${pretty(alias)}`
                    break
                }
                case "TypeAliasStatement":
                case "ExportTypeAliasStatement":
                    if (parent.name === node) return aliasText(analysis, parent)
                    break
                case "DeclareStatement":
                    if (parent.id === node) return declareText(analysis, parent)
                    break
                case "DeclareClassStatement":
                    if (parent.name === node) return classText(analysis, name)
                    break
                case "ClassDeclaration":
                    if (parent.name === node) return classText(analysis, name)
                    break
                case "ClassField":
                    if (parent.name === node) {
                        const type = typeOfNode(parent.typeAnnotation) ??
                            types.typeOf.get(parent.init as Expression | undefined as Expression)
                        const prefix = parent.isStatic ? "(static) " : "(field) "
                        return type ? `${prefix}${name}: ${pretty(type)}` : `${prefix}${name}`
                    }
                    break
                case "ClassAccessor":
                    if (parent.name === node) return `(${parent.kind === "get" ? "getter" : "setter"}) ${name}`
                    break
                case "TableTypeProperty":
                    if (parent.key === node) {
                        const type = typeOfNode(parent.valueType)
                        const readonly = parent.readonly ? "readonly " : ""
                        return type && `(property) ${readonly}${name}${parent.optional ? "?" : ""}: ${pretty(type)}`
                    }
                    break
                case "FunctionTypeParameter":
                    if (parent.id === node) {
                        const type = typeOfNode(parent.typeAnnotation)
                        return type && `(parameter) ${name}${parent.optional ? "?" : ""}: ${pretty(type)}`
                    }
                    break
                case "GenericTypeParameter":
                    if (parent.id === node) return typeParameterText(analysis, parent)
                    break
                case "InferTypeNode":
                    if (parent.id === node) return `(type parameter) infer ${name}`
                    break
                case "MappedTypeNode":
                    if (parent.parameterId === node) {
                        const keys = typeOfNode(parent.constraint)
                        return `(type parameter) ${name}${keys ? ` in ${formatType(keys)}` : ""}`
                    }
                    break
            }

            // A reference: prefer the narrowed type — what the code sees here,
            // and the whole reason for narrowing.
            const narrowed = types.narrowedTypeOf.get(identifier)
            if (narrowed) return `${name}: ${pretty(narrowed)}`
            const binding = bindingOfNode(analysis, identifier)
            if (binding) {
                const type = types.bindingType.get(binding.id)
                if (type) return bindingText(binding, type)
            }
            // `x.foo` / `x:foo()` — the member's own type.
            if (parent?.type === "MemberExpression" || parent?.type === "MethodCallExpression") {
                const type = types.typeOf.get(parent as unknown as Expression)
                if (type) return `${name}: ${pretty(type)}`
            }
            return undefined
        }

        // `...` — what this function's extra arguments are.
        case "VarargExpression": {
            const type = types.typeOf.get(node as unknown as Expression)
            return type ? `(vararg) ...: ${pretty(type)}` : undefined
        }

        // Declarations: `const x`, a parameter.
        case "IdentifierPattern":
        case "FunctionParameter":
        case "TypedIdentifier": {
            const binding = bindingOfNode(analysis, node)
            const type = binding && types.bindingType.get(binding.id)
            return type ? bindingText(binding, type) : undefined
        }

        // A type written by name: `number`, `Shape`, `Partial<User>`, or a type
        // parameter in scope.
        case "TypeReference": {
            const base = node.base as string
            if (!node.namespace) {
                const parameter = typeParameterInScope(path, index, base)
                if (parameter) return typeParameterText(analysis, parameter)
                if (PRIMITIVES.has(base)) return `type ${base}`
            }
            // A plain alias: its definition. The resolved type carries the
            // alias's name, so printing that would read `type Shape = Shape`.
            if (!(node.typeArguments as unknown[]).length) {
                // `Enum.Material` is declared under its qualified name.
                const qualified = node.namespace ? `${node.namespace}.${base}` : base
                const alias = types.aliases.get(qualified)
                if (alias && isClassType(alias)) return classText(analysis, qualified)
                if (alias) return `type ${qualified} = ${pretty(alias)}`
            }
            const type = typeOfNode(node)
            return type && `type ${referenceText(analysis, node)} = ${pretty(type)}`
        }
    }

    // Any other part of a type — `typeof x`, `keyof T`, a union — reads as what
    // it resolves to; any expression as its type.
    const annotated = typeOfNode(node)
    if (annotated) return pretty(annotated)
    const type = types.typeOf.get(node as unknown as Expression)
    return type ? pretty(type) : undefined
}

/** `type Name<T extends C> = ...` */
function aliasText(analysis: Analysis, statement: AnyNode): string | undefined {
    const name = (statement.name as Identifier).name
    const alias = analysis.types.aliases.get(name)
    if (!alias) return undefined
    const generics = (statement.generics as AnyNode[] | undefined) ?? []
    const parameters = generics.length
        ? `<${generics.map(g => typeParameterSignature(analysis, g)).join(", ")}>`
        : ""
    return `type ${name}${parameters} = ${pretty(alias)}`
}

/** `declare math: {...}` / `declare function f(x: number) -> string (+2 overloads)`.
 *  A name declared several times is an overload set: show the signature this
 *  particular declaration contributes, and how many others there are. */
function declareText(analysis: Analysis, statement: AnyNode): string | undefined {
    const name = statement.name as string
    const own = analysis.types.typeOfTypeNode.get(statement.valueType as TypeNode)
    if (!own) return undefined
    if (own.kind !== "function") return `declare ${name}: ${pretty(own)}`
    // Declaring a name more than once makes an overload set. Count what every
    // top-level declaration of the name contributes — read from the AST, since
    // a declared name nothing references has no binding to read it from.
    const total = (analysis.program.body.statements as unknown as AnyNode[])
        .filter(s => s.type === "DeclareStatement" && s.name === name)
        .reduce((n, s) => n + signaturesOf(analysis.types.typeOfTypeNode.get(s.valueType as TypeNode)).length, 0)
    const others = total - 1
    const overloads = others > 0 ? `  (+${others} overload${others > 1 ? "s" : ""})` : ""
    return `declare function ${name}${formatType(own)}${overloads}`
}

/** `declare class Part extends BasePart { ... }` — the members this class
 *  adds. What it inherits is a hover away, on the superclass. */
function classText(analysis: Analysis, name: string): string | undefined {
    const type = analysis.types.aliases.get(name)
    if (!type || !isClassType(type)) return undefined
    const superclass = type.class.superclass
    const inherited = superclass ? analysis.types.aliases.get(superclass) : undefined
    const own = [...type.properties].filter(([key, property]) =>
        // `ClassObject` is on every instance and says nothing about this one.
        key !== "ClassObject" &&
        (inherited?.kind !== "object" || inherited.properties.get(key) !== property))
    // A `class ... end` and a `declare class` are the same type; only the way
    // they are written differs, and hover shows each the way it is written.
    const written = isRuntimeClass(analysis, name)
    const head = `${written ? "" : "declare "}class ${name}${superclass ? ` extends ${superclass}` : ""}`
    const lines = own.map(([key, property]) =>
        `    ${property.readonly ? "readonly " : ""}${key}${property.optional ? "?" : ""}: ${formatType(property.type)}${written ? "" : ","}`)
    if (written) return own.length ? `${head}\n${lines.join("\n")}\nend` : `${head}\nend`
    return own.length ? `${head} {\n${lines.join("\n")}\n}` : `${head} {}`
}

/** Is `name` a class this file writes out, rather than one a definitions
 *  file declares? */
function isRuntimeClass(analysis: Analysis, name: string): boolean {
    return analysis.program.body.statements.some(statement => {
        const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
        return declaration.type === "ClassDeclaration" && declaration.name.name === name
    })
}

interface TypeParameterNode {
    name: string
    constraint?: unknown
    isConst?: boolean
    infer?: boolean
}

function typeParameterText(analysis: Analysis, parameter: TypeParameterNode | AnyNode): string {
    return `(type parameter) ${typeParameterSignature(analysis, parameter)}`
}

function typeParameterSignature(analysis: Analysis, parameter: TypeParameterNode | AnyNode): string {
    const p = parameter as TypeParameterNode
    if (p.infer) return `infer ${p.name}`
    const constraint = p.constraint ? analysis.types.typeOfTypeNode.get(p.constraint as TypeNode) : undefined
    return `${p.isConst ? "const " : ""}${p.name}${constraint ? ` extends ${formatType(constraint)}` : ""}`
}

/** The type parameter `name` refers to at this point: from an enclosing
 *  generic list, a mapped type's key, or an `infer` in a conditional. */
function typeParameterInScope(path: readonly Spanned[], index: number, name: string): TypeParameterNode | undefined {
    for (let i = index - 1; i >= 0; i--) {
        const a = path[i] as AnyNode
        const generic = (a.generics as TypeParameterNode[] | undefined)?.find(g => g.name === name)
        if (generic) return generic
        if (a.type === "MappedTypeNode" && a.parameter === name) return { name }
        if (a.type === "ConditionalTypeNode" && bindsInfer(a.extendsType, name)) return { name, infer: true }
    }
    return undefined
}

function bindsInfer(node: unknown, name: string): boolean {
    if (!node || typeof node !== "object") return false
    if (Array.isArray(node)) return node.some(n => bindsInfer(n, name))
    const n = node as AnyNode
    if (n.type === "InferTypeNode" && n.name === name) return true
    return Object.values(n).some(v => bindsInfer(v, name))
}

/** `Partial<User>` — the reference with its arguments resolved. */
function referenceText(analysis: Analysis, reference: AnyNode): string {
    const name = reference.namespace ? `${reference.namespace}.${reference.base}` : (reference.base as string)
    const args = (reference.typeArguments as unknown[]) ?? []
    if (!args.length) return name
    const resolved = args.map(a => {
        const t = analysis.types.typeOfTypeNode.get(a as TypeNode)
        return t ? formatType(t) : "?"
    })
    return `${name}<${resolved.join(", ")}>`
}

function fieldWithKey(table: AnyNode, key: AnyNode): { value: Expression } | undefined {
    const fields = table.fields as { type: string; key?: unknown; value: Expression }[]
    return fields.find(f => f.type === "TableFieldNamed" && f.key === key)
}

/** Long object types one member per line, overload sets one signature per
 *  line — `math` on a single line is thousands of characters. */
function pretty(type: Type): string {
    const flat = formatType(type)
    if (flat.length <= 80) return flat
    if (type.kind === "object") {
        const lines: string[] = []
        if (type.indexer) lines.push(`    [${formatType(type.indexer.key)}]: ${formatType(type.indexer.value)},`)
        for (const [name, property] of type.properties) {
            const readonly = property.readonly ? "readonly " : ""
            lines.push(`    ${readonly}${name}${property.optional ? "?" : ""}: ${formatType(property.type)},`)
        }
        return `{\n${lines.join("\n")}\n}`
    }
    if (type.kind === "intersection" && type.types.every(t => t.kind === "function")) {
        return type.types.map(formatType).join("\n& ")
    }
    return flat
}

/** `const x: number`, `function f(a: string) -> number`, `(import) util: {...}`. */
function bindingText(binding: Binding, type: Type): string {
    if (binding.declaredBy === "function" && type.kind === "function") {
        return `function ${binding.name}${formatType(type)}`
    }
    return `${keyword(binding)} ${binding.name}: ${pretty(type)}`
}

function keyword(binding: Binding): string {
    if (binding.kind === "param" || binding.kind === "self") return "(parameter)"
    if (binding.kind === "global") return "(global)"
    if (binding.kind.startsWith("for-")) return "(loop variable)"
    if (binding.declaredBy === "import" || binding.declaredBy === "namespace") return "(import)"
    if (binding.declaredBy === "type") return "(type import)"
    if (binding.declaredBy === "function") return "function"
    return binding.isConst ? "const" : "let"
}

function code(text: string): string {
    // Its own grammar: VS Code colours a hover's code block with TextMate
    // only, and the editor's luaut grammar deliberately leaves names and
    // types to semantic tokens. Hover text is output this server formats,
    // so a grammar for that format is exact rather than a guess.
    return "```luaut-hover\n" + text + "\n```"
}
