/**
 * Expanding a type one level at a time.
 *
 * A hover shows the shortest true thing first — `const b: Shape` — and says
 * more each time it is asked, as TypeScript's does: `{ kind: "circle", size:
 * number }`, then whatever `Shape`'s members are named after. Each level
 * replaces the names standing one step further in.
 *
 * Expansion is by *name*: a type printed as a name is one whose structure is
 * being withheld, so that is exactly what there is left to show. A class is
 * the exception — it is nominal, its members name it back, and `Part` is what
 * it is called rather than a shorthand for its shape.
 */
import {
    isClassType, arrayOf, tuple, objectType, fn, union, intersection,
    aliasNameOf, withoutAliasName, type Type,
} from "luaut-parser"

/** `type`, with the names standing one step in replaced by what they stand
 *  for, `depth` times over. `seen` holds the names already opened along this
 *  path, so a type that names itself stops rather than unrolling forever. */
export function expandAliases(
    type: Type,
    aliases: ReadonlyMap<string, Type>,
    depth: number,
    seen: readonly string[] = [],
): Type {
    if (depth <= 0) return type
    const name = withheldName(type)
    if (name !== undefined && !seen.includes(name)) {
        const opened = aliases.get(name) ?? type
        const inner = [...seen, name]
        return children(unnamed(opened), t => expandAliases(t, aliases, depth - 1, inner))
    }
    return children(type, t => expandAliases(t, aliases, depth, seen))
}

/** The name a type is printed as instead of its structure, if it has one.
 *  The parser keeps it for every kind an alias can stand for — `type Id =
 *  number` included — so a level opens one name, not every name beneath it. */
function withheldName(type: Type): string | undefined {
    if (type.kind === "genericRef") return type.typeArguments.length ? undefined : type.name
    return aliasNameOf(type)
}

/** The same type, printed as what it is made of. */
function unnamed(type: Type): Type {
    return withoutAliasName(type)
}

/** `type` with `f` applied to each type inside it. Only the kinds a hover
 *  prints structurally are walked; the rest stand for themselves. */
function children(type: Type, f: (t: Type) => Type): Type {
    switch (type.kind) {
        case "array":
            return arrayOf(f(type.element))
        case "tuple":
            return tuple(type.elements.map(f), type.isPack)
        case "union":
            return union(type.types.map(f))
        case "intersection": {
            const out = intersection(type.types.map(f))
            return type.name && out.kind === "intersection" ? { ...out, name: type.name } : out
        }
        case "object": {
            if (isClassType(type)) return type
            const out = objectType(
                [...type.properties].map(([name, property]) => [name, { ...property, type: f(property.type) }]),
                type.indexer && { key: type.indexer.key, value: f(type.indexer.value) },
                type.frozen,
            )
            if (type.name) out.name = type.name
            return out
        }
        case "function":
            return fn(
                type.params.map(p => ({ ...p, type: f(p.type) })),
                f(type.returns),
                type.varargs && f(type.varargs),
                type.typeParams,
                type.predicate,
            )
        default:
            return type
    }
}
