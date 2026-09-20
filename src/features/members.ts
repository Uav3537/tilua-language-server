/** What members a type has — shared by completion and signature help. */
import { formatType, substitute, union, type FunctionType, type ObjectProperty, type Type } from "@tilua/parser"

export interface Member {
    name: string
    property: ObjectProperty
    /** True when the member is a function whose first parameter is `self` —
     *  i.e. it is meant to be called with `:`. */
    isMethod: boolean
}

/** The keys an index signature spells out one by one, if it does. */
function literalKeys(key: Type | undefined, aliases: ReadonlyMap<string, Type>): string[] {
    if (!key) return []
    const resolved = key.kind === "genericRef" ? aliases.get(key.name) : key
    if (!resolved) return []
    const parts = resolved.kind === "union" ? resolved.types : [resolved]
    const out: string[] = []
    for (const part of parts) {
        const member = part.kind === "genericRef" ? aliases.get(part.name) ?? part : part
        if (member.kind !== "literal" || typeof member.value !== "string") return []
        out.push(member.value)
    }
    return out
}

/** The members of `type`, following aliases, merging intersections and keeping
 *  only what every member of a union has (you can only reach a property that
 *  is there whichever way the union went). */
export function membersOf(
    type: Type | undefined,
    aliases: ReadonlyMap<string, Type>,
    seen = new Set<Type>(),
): Member[] {
    if (!type || seen.has(type)) return []
    seen.add(type)

    switch (type.kind) {
        case "object": {
            const out: Member[] = []
            for (const [name, property] of type.properties) {
                out.push({ name, property, isMethod: takesSelf(property.type) })
            }
            // `{ [("a" | "b")]: V }` covers a countable set of keys, so those
            // keys are members too — optional, since an index signature does
            // not promise any of them is there. `[string]` names none.
            for (const name of literalKeys(type.indexer?.key, aliases)) {
                if (type.properties.has(name)) continue
                const property = { type: type.indexer!.value, optional: true }
                out.push({ name, property, isMethod: takesSelf(property.type) })
            }
            return out
        }
        case "intersection": {
            // Overload sets are intersections of functions and have no
            // members of their own; a `A & B` object contributes both sides.
            const merged = new Map<string, Member>()
            for (const part of type.types) {
                for (const member of membersOf(part, aliases, seen)) merged.set(member.name, member)
            }
            return [...merged.values()]
        }
        case "union": {
            const perBranch = type.types.map(part => membersOf(part, aliases, seen))
            if (!perBranch.length) return []
            const [first, ...rest] = perBranch
            return first.filter(member => rest.every(other => other.some(m => m.name === member.name)))
        }
        case "genericRef": {
            const alias = aliases.get(type.name)
            return alias ? membersOf(alias, aliases, seen) : []
        }
        case "typeParam":
            return membersOf(type.constraint, aliases, seen)
        // An array and a string answer to the methods the language gives them
        // — `names:filter(f)`, `text:trim()`. They are written in the parser's
        // prelude as `ArrayMethods<T>` and `StringMethods`, so the element
        // type goes in where `T` stands.
        case "array":
        case "tuple": {
            const element = type.kind === "array" ? type.element : union(type.elements)
            const methods = aliases.get("ArrayMethods")
            return methods
                ? membersOf(substitute(methods, new Map([["T", element]])), aliases, seen)
                : []
        }
        case "primitive":
            return type.name === "string" ? membersOf(aliases.get("StringMethods"), aliases, seen) : []
        case "literal":
            return type.base === "string" ? membersOf(aliases.get("StringMethods"), aliases, seen) : []
        default:
            return []
    }
}

export function takesSelf(type: Type): boolean {
    for (const signature of signaturesOf(type)) {
        // A class method writes its receiver `this`; `function T:m()` writes `self`.
        const first = signature.params[0]?.name
        if (first === "self" || first === "this") return true
    }
    return false
}

/** Every call signature of `type` — one for a function, several for an
 *  overload set (which is an intersection of function types). */
export function signaturesOf(type: Type | undefined, aliases?: ReadonlyMap<string, Type>): FunctionType[] {
    if (!type) return []
    if (type.kind === "function") return [type]
    if (type.kind === "intersection") return type.types.flatMap(t => signaturesOf(t, aliases))
    if (type.kind === "genericRef" && aliases) {
        const alias = aliases.get(type.name)
        return alias ? signaturesOf(alias, aliases) : []
    }
    return []
}

/** `(a: number, b?: string) => boolean`, and the pieces of it, for signature
 *  help — which needs each parameter's own label to highlight the active one. */
export function signatureLabel(signature: FunctionType): { label: string; parameters: string[] } {
    const parameters = signature.params.map((p, i) => {
        const name = p.name ?? `arg${i + 1}`
        return `${name}${p.optional ? "?" : ""}: ${formatType(p.type)}`
    })
    const generics = signature.typeParams?.length ? `<${signature.typeParams.join(", ")}>` : ""
    // A rest parameter, written the way tilua writes one.
    const varargs = !signature.varargs ? []
        : signature.restIsWhole ? [`...args: ${formatType(signature.varargs)}`]
        : [`...args: ${formatType(signature.varargs)}[]`]
    const label = `${generics}(${[...parameters, ...varargs].join(", ")}) => ${formatType(signature.returns)}`
    return { label, parameters }
}
