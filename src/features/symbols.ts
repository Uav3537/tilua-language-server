/** Document symbols: the outline of a file. */
import { SymbolKind, type DocumentSymbol } from "vscode-languageserver"
import { formatType, type ClassDeclaration, type ClassMember, type Identifier } from "@tilua/parser"
import { bindingOfNode, type Analysis } from "../analysis.js"
import { toRange, walk, type Spanned } from "../ast-utils.js"

export function documentSymbols(analysis: Analysis): DocumentSymbol[] {
    const out: DocumentSymbol[] = []

    walk(analysis.program, node => {
        switch (node.type) {
            case "FunctionDeclaration":
            case "FunctionDeclarationStatement": {
                const name = functionName(node)
                if (name) out.push(symbol(name, SymbolKind.Function, node, detailOf(analysis, node)))
                break
            }
            case "TypeAliasStatement":
            case "ExportTypeAliasStatement": {
                // The alias name is an Identifier node here, a bare string on
                // a `declare` — take either.
                const named = (node as unknown as { name?: string | { name?: string } }).name
                const name = typeof named === "string" ? named : named?.name
                if (name) {
                    const alias = analysis.types.aliases.get(name)
                    out.push(symbol(name, SymbolKind.Interface, node, alias ? formatType(alias) : undefined))
                }
                break
            }
            case "ClassDeclaration": {
                const declaration = node as unknown as ClassDeclaration
                const superclass = declaration.superclass?.name
                out.push({
                    ...symbol(declaration.name.name, SymbolKind.Class, node, superclass && `extends ${superclass}`),
                    children: declaration.members.map(member => classMember(analysis, member)),
                })
                break
            }
            case "DeclareClassStatement": {
                const name = (node as unknown as { name: Identifier }).name.name
                const superclass = (node as unknown as { superclass?: { base: string } }).superclass?.base
                out.push(symbol(name, SymbolKind.Class, node, superclass && `extends ${superclass}`))
                break
            }
            case "VariableDeclaration": {
                const target = (node as unknown as { name: Spanned }).name
                const name = (target as unknown as { name?: string }).name
                if (name) out.push(symbol(name, SymbolKind.Variable, target))
                break
            }
        }
    })

    return out
}

/** One line of a class's outline. A `get`/`set` is a property, not a
 *  function: that is how it is read. */
function classMember(analysis: Analysis, member: ClassMember): DocumentSymbol {
    switch (member.type) {
        case "ClassConstructor":
            return symbol("constructor", SymbolKind.Constructor, member)
        case "ClassField":
            return symbol(member.name.name, member.isStatic ? SymbolKind.Constant : SymbolKind.Field, member,
                member.typeAnnotation ? undefined : detailOf(analysis, member))
        case "ClassAccessor":
            return symbol(member.name.name, SymbolKind.Property, member, member.kind)
        case "ClassMethod":
            return symbol(member.name.name, SymbolKind.Method, member, member.isStatic ? "static" : undefined)
    }
}

function functionName(node: Spanned): string | undefined {
    const named = node as unknown as {
        name?: string | { name?: string }
        target?: { base?: { name?: string }; path?: { name?: string }[]; method?: { name: string } }
    }
    if (typeof named.name === "string") return named.name
    if (named.name && typeof named.name === "object") return named.name.name
    if (named.target?.base?.name) {
        const path = (named.target.path ?? []).map(p => p.name).filter(Boolean)
        const dotted = [named.target.base.name, ...path].join(".")
        return named.target.method ? `${dotted}:${named.target.method.name}` : dotted
    }
    return undefined
}

/** A function declaration is a statement, not an expression, so its type
 *  comes from the binding it creates rather than from `typeOf`. */
function detailOf(analysis: Analysis, node: Spanned): string | undefined {
    const name = (node as unknown as { name?: Identifier }).name
    if (name && typeof name === "object") {
        const binding = bindingOfNode(analysis, name)
        const type = binding && analysis.types.bindingType.get(binding.id)
        if (type) return formatType(type)
    }
    return undefined
}

function symbol(name: string, kind: SymbolKind, node: Spanned, detail?: string): DocumentSymbol {
    const range = toRange(node)
    return { name, kind, detail, range, selectionRange: range }
}
