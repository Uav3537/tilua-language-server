/**
 * Position mapping and AST lookup.
 *
 * tilua spans are 1-based with an exclusive end column; LSP positions are
 * 0-based. Every conversion between the two lives here so the features never
 * do the arithmetic themselves.
 */
import type { Position, Range } from "vscode-languageserver"

/** The shape every tilua AST node shares. */
export interface Spanned {
    type?: string
    line: { start: number; end: number }
    column: { start: number; end: number }
}

export function isSpanned(v: unknown): v is Spanned {
    if (!v || typeof v !== "object") return false
    const n = v as Record<string, unknown>
    return typeof n.line === "object" && n.line !== null && typeof n.column === "object" && n.column !== null
}

export function toRange(node: Spanned): Range {
    return {
        start: { line: node.line.start - 1, character: node.column.start - 1 },
        end: { line: node.line.end - 1, character: node.column.end - 1 },
    }
}

/** A one-character range, for a diagnostic on a node with a collapsed span. */
export function toPosition(line: number, column: number): Position {
    return { line: line - 1, character: column - 1 }
}

/** Is `pos` inside `node`'s span? The end is exclusive, except that `inclusive`
 *  admits a cursor sitting immediately after the node — which is where it is
 *  while you are still typing the identifier under it. */
export function containsPosition(node: Spanned, pos: Position, inclusive = false): boolean {
    const startLine = node.line.start - 1
    const endLine = node.line.end - 1
    if (pos.line < startLine || pos.line > endLine) return false
    if (pos.line === startLine && pos.character < node.column.start - 1) return false
    if (pos.line === endLine) {
        const end = node.column.end - 1
        if (inclusive ? pos.character > end : pos.character >= end) return false
    }
    return true
}

/** Every child node of `node`, in source order-ish (declaration order of the
 *  fields). Generic on purpose: it walks the object graph rather than knowing
 *  the node types, so a new node kind in the parser needs no change here.
 *
 *  Some nodes carry no span — the field wrappers of object literals
 *  (`TableFieldNamed`) and type literals (`TableTypeProperty`). They are
 *  walked *through*: their own children are returned in their place. Skipping
 *  them would hide everything inside, which is how hovering an object key used
 *  to land on the whole object. */
export function children(node: Spanned): Spanned[] {
    const out: Spanned[] = []
    collect(node, out)
    return out
}

function collect(container: object, out: Spanned[]): void {
    for (const key of Object.keys(container)) {
        if (key === "line" || key === "column") continue
        const value = (container as Record<string, unknown>)[key]
        for (const item of Array.isArray(value) ? value : [value]) {
            if (isSpanned(item)) out.push(item)
            else if (isSpanlessNode(item)) collect(item, out)
        }
    }
}

/** A node-shaped object (it has a `type` tag) that has no span of its own. */
function isSpanlessNode(v: unknown): v is object {
    // Anything in the tree that carries no span of its own: a template's parts
    // (`{ kind: "expression", expression }`), a ternary's clauses
    // (`{ condition, body }`). What they hold are nodes like any other.
    return !!v && typeof v === "object" && !Array.isArray(v)
}

/** The chain of nodes containing `pos`, outermost first — the last entry is
 *  the innermost node at the cursor and the ones before it are its ancestors.
 *
 *  It descends through every child rather than only children that contain
 *  `pos`, because a parent's span does not always cover its child's: a
 *  binding's span is the name alone, while its type annotation sits after it.
 *  So an ancestor in this path is a real ancestor, but not necessarily one
 *  whose own span contains the cursor. */
export function pathAt(root: Spanned, pos: Position, inclusive = false): Spanned[] {
    let best: Spanned[] | undefined

    const descend = (node: Spanned, ancestors: Spanned[]): void => {
        const here = [...ancestors, node]
        if (containsPosition(node, pos, inclusive)) {
            // Prefer the narrowest hit, and among equals the deepest — that is
            // the node the cursor is really "on".
            const incumbent = best?.[best.length - 1]
            if (!incumbent
                || spanLength(node) < spanLength(incumbent)
                || (spanLength(node) === spanLength(incumbent) && here.length > best!.length)) {
                best = here
            }
        }
        for (const child of children(node)) descend(child, here)
    }

    descend(root, [])
    return best ?? []
}

/** The innermost node containing `pos`. */
export function nodeAt(root: Spanned, pos: Position, inclusive = false): Spanned | undefined {
    const path = pathAt(root, pos, inclusive)
    return path[path.length - 1]
}

/** The innermost node of one of `types` containing `pos`. */
export function enclosing<T extends Spanned>(
    root: Spanned,
    pos: Position,
    types: readonly string[],
    inclusive = false,
): T | undefined {
    const path = pathAt(root, pos, inclusive)
    for (let i = path.length - 1; i >= 0; i--) {
        if (path[i].type && types.includes(path[i].type as string)) return path[i] as T
    }
    return undefined
}

function spanLength(node: Spanned): number {
    // Line count dominates: a node spanning fewer lines is nested deeper.
    return (node.line.end - node.line.start) * 10000 + (node.column.end - node.column.start)
}

/** Walk every node under `root`, depth first. */
export function walk(root: Spanned, visit: (node: Spanned, parent?: Spanned) => void, parent?: Spanned): void {
    visit(root, parent)
    for (const child of children(root)) walk(child, visit, root)
}
