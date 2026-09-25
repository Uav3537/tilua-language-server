/**
 * Go-to-definition, find-references, rename and document highlight — all four
 * are the same question ("which binding is this, and where else does it
 * appear?") asked with different answers.
 */
import {
    DocumentHighlightKind,
    type DocumentHighlight, type Location, type Position, type Range,
    type TextEdit, type WorkspaceEdit,
} from "vscode-languageserver"
import { isIdentifier, type Binding } from "@tilua/parser"
import { bindingOfNode, type Analysis } from "../analysis.js"
import { isImplicit, pathAt, toRange, type Spanned } from "../ast-utils.js"

/** Nodes that can name a binding — as a use or as its declaration. */
const NAMING = new Set(["Identifier", "IdentifierPattern", "FunctionParameter", "TypedIdentifier"])

/** The binding referred to at `position`, if the cursor is on a variable —
 *  a use of it or its declaration. */
export function bindingAt(analysis: Analysis, position: Position): Binding | undefined {
    const path = pathAt(analysis.program, position, true)
    for (let i = path.length - 1; i >= 0; i--) {
        const node = path[i]
        if (!node.type || !NAMING.has(node.type)) continue
        const binding = bindingOfNode(analysis, node)
        if (binding) return binding
    }
    return undefined
}

/** Every place the binding appears: its declaration plus every reference. An
 *  implicit `this`/`self` is declared nowhere in the text, so only its uses. */
function sites(binding: Binding): Spanned[] {
    const out: Spanned[] = []
    if (binding.declarationNode && !isImplicit(binding.declarationNode)) {
        out.push(binding.declarationNode as unknown as Spanned)
    }
    out.push(...(binding.references as unknown as Spanned[]))
    return out
}

export function definition(analysis: Analysis, position: Position): Location | null {
    const binding = bindingAt(analysis, position)
    if (!binding?.declarationNode) return null
    return { uri: analysis.uri, range: toRange(binding.declarationNode as unknown as Spanned) }
}

export function references(
    analysis: Analysis,
    position: Position,
    includeDeclaration: boolean,
): Location[] {
    const binding = bindingAt(analysis, position)
    if (!binding) return []
    const nodes = includeDeclaration ? sites(binding) : (binding.references as unknown as Spanned[])
    return nodes.map(node => ({ uri: analysis.uri, range: toRange(node) }))
}

export function highlights(analysis: Analysis, position: Position): DocumentHighlight[] {
    const binding = bindingAt(analysis, position)
    if (!binding) return []
    return sites(binding).map(node => ({
        range: toRange(node),
        kind: node === binding.declarationNode
            ? DocumentHighlightKind.Write
            : DocumentHighlightKind.Read,
    }))
}

/** The range rename would replace, and the current name — so the editor can
 *  refuse before it asks for a new one. */
export function prepareRename(
    analysis: Analysis,
    position: Position,
): { range: Range; placeholder: string } | null {
    const binding = bindingAt(analysis, position)
    if (!binding) return null
    // A builtin lives in a definitions file; renaming it here would rename the
    // uses and leave the declaration behind. `this` and `self` are names the
    // language gives, not the file.
    if (!renamable(binding)) return null
    const path = pathAt(analysis.program, position, true)
    const identifier = [...path].reverse().find(n => !!n.type && NAMING.has(n.type))
    if (!identifier) return null
    return { range: toRange(identifier), placeholder: binding.name }
}

export function rename(analysis: Analysis, position: Position, newName: string): WorkspaceEdit | null {
    if (!isIdentifier(newName)) return null
    const binding = bindingAt(analysis, position)
    if (!binding || !renamable(binding)) return null
    const edits: TextEdit[] = sites(binding).map(node => ({ range: toRange(node), newText: newName }))
    return { changes: { [analysis.uri]: edits } }
}

function renamable(binding: Binding): boolean {
    return !binding.isBuiltin && !!binding.declarationNode && !isImplicit(binding.declarationNode)
}
