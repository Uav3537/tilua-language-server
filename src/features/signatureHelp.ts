/**
 * Signature help: the parameter list of the call the cursor sits inside.
 *
 * A call being typed is usually not yet a call — `add(1, ` has no argument
 * after the comma and no closing paren, and the parser drops the statement.
 * So, like completion, this analyzes a repaired copy of the text: the fewest
 * characters that make the call parse, tried in order.
 */
import type { Position, SignatureHelp, SignatureInformation } from "vscode-languageserver"
import type { TextDocument } from "vscode-languageserver-textdocument"
import { parseWithRecovery, type Expression, type Program } from "@tilua/parser"
import type { Analyzer, Analysis } from "../analysis.js"
import { containsPosition, pathAt, type Spanned } from "../ast-utils.js"
import { signaturesOf, signatureLabel } from "./members.js"

interface CallLike extends Spanned {
    type: "CallExpression" | "MethodCallExpression"
    arguments: Expression[]
}

export function signatureHelp(
    analyzer: Analyzer,
    document: TextDocument,
    position: Position,
): SignatureHelp | null {
    const source = document.getText()
    const offset = document.offsetAt(position)
    for (const repair of ["", "nil", "nil)", ")"]) {
        const text = source.slice(0, offset) + repair + source.slice(offset)
        // Only a text with a call at the cursor is worth its types: parsing
        // says so for a fraction of what analyzing would cost. The text as it
        // is written is the document's own analysis, which is kept.
        if (!callAt(parseWithRecovery(text).program, position)) continue
        const analysis = repair ? analyzer.analyze(document.uri, -1, text) : analyzer.get(document)
        const found = helpAt(analysis, position)
        if (found) return found
    }
    return null
}

function callAt(program: Program, position: Position): CallLike | undefined {
    const path = pathAt(program, position, true)
    return [...path].reverse().find(
        n => n.type === "CallExpression" || n.type === "MethodCallExpression",
    ) as CallLike | undefined
}

function helpAt(analysis: Analysis, position: Position): SignatureHelp | null {
    const call = callAt(analysis.program, position)
    if (!call) return null

    const callee = call.type === "CallExpression"
        ? (call as unknown as { callee: Expression }).callee
        : (call as unknown as Expression)
    // For a method call the callee has no node of its own, so read the type of
    // the whole `obj:m` receiver path from the object plus the method name.
    const calleeType = call.type === "CallExpression"
        ? analysis.types.typeOf.get(callee)
        : methodType(analysis, call)

    const signatures = signaturesOf(calleeType, analysis.types.aliases)
    if (!signatures.length) return null

    // `:` supplies `self`, so the first written argument is the second param.
    const selfOffset = call.type === "MethodCallExpression" ? 1 : 0
    const written = activeArgument(call, position)

    const infos: SignatureInformation[] = signatures.map(signature => {
        const { label, parameters } = signatureLabel(signature)
        return { label, parameters: parameters.map(p => ({ label: p })) }
    })

    // Pick the overload that could still accept this many arguments.
    const wanted = written + selfOffset + 1
    let active = signatures.findIndex(s => s.params.length >= wanted || s.varargs)
    if (active < 0) active = 0

    return {
        signatures: infos,
        activeSignature: active,
        activeParameter: Math.min(
            written + selfOffset,
            Math.max(0, signatures[active].params.length - 1),
        ),
    }
}

function methodType(analysis: Analysis, call: CallLike): undefined | ReturnType<Analysis["types"]["typeOf"]["get"]> {
    const object = (call as unknown as { object: Expression }).object
    const method = (call as unknown as { method: { name: string } }).method
    const objectType = analysis.types.typeOf.get(object)
    if (!objectType) return undefined
    return memberType(objectType, method.name, analysis)
}

function memberType(
    type: NonNullable<ReturnType<Analysis["types"]["typeOf"]["get"]>>,
    name: string,
    analysis: Analysis,
): ReturnType<Analysis["types"]["typeOf"]["get"]> {
    if (type.kind === "object") return type.properties.get(name)?.type
    if (type.kind === "intersection") {
        for (const part of type.types) {
            const found = memberType(part, name, analysis)
            if (found) return found
        }
    }
    if (type.kind === "genericRef") {
        const alias = analysis.types.aliases.get(type.name)
        if (alias) return memberType(alias, name, analysis)
    }
    return undefined
}

/** Which argument the cursor is in — counted by which argument spans it, or
 *  by how many end before it when the cursor is in the gap after a comma. */
function activeArgument(call: CallLike, position: Position): number {
    const args = call.arguments
    for (let i = 0; i < args.length; i++) {
        if (containsPosition(args[i] as unknown as Spanned, position, true)) return i
    }
    let count = 0
    for (const arg of args as unknown as Spanned[]) {
        const before = arg.line.end - 1 < position.line
            || (arg.line.end - 1 === position.line && arg.column.end - 1 <= position.character)
        if (before) count++
    }
    return count
}
