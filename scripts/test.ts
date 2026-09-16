/**
 * Feature tests.
 *
 * Each case is a source fragment with a `‸` marking the cursor: the harness
 * strips it, works out the position, and asks one feature. No server is
 * spawned — the features are plain functions, which is the point of keeping
 * the LSP wiring in `server.ts` and nothing else.
 */
import { TextDocument } from "vscode-languageserver-textdocument"
import { Analyzer } from "../src/analysis.js"
import { diagnostics } from "../src/features/diagnostics.js"
import { hover } from "../src/features/hover.js"
import { definition, references, rename } from "../src/features/navigation.js"
import { completion } from "../src/features/completion.js"
import { signatureHelp } from "../src/features/signatureHelp.js"
import { documentSymbols } from "../src/features/symbols.js"
import { SymbolKind } from "vscode-languageserver"
import { semanticTokens } from "../src/features/semanticTokens.js"
import type { Position } from "vscode-languageserver"

import { readFileSync } from "node:fs"
import { parse } from "@tilua/parser"

// The parser has no types built in. These tests analyze against the Lua and
// Roblox libraries, as a project whose config lists them would — in that
// order, since Roblox's adds to Lua's.
const testLibs = ["lua", "roblox"].map(name =>
    parse(readFileSync(new URL(`../node_modules/@tilua-types/${name}/index.d.tilua`, import.meta.url), "utf8")))
const analyzer = new Analyzer({ libs: testLibs })
let passed = 0
const failures: string[] = []

let documentCount = 0

function open(source: string): { document: TextDocument; cursor: Position } {
    // Not `|`: that is the union operator, and it turns up in the fixtures.
    const index = source.indexOf("‸")
    const text = index < 0 ? source : source.slice(0, index) + source.slice(index + 1)
    const document = TextDocument.create(`file:///test${documentCount++}.tilua`, "tilua", 1, text)
    return { document, cursor: index < 0 ? { line: 0, character: 0 } : document.positionAt(index) }
}

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) { passed++; return }
    failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

function contains(name: string, haystack: readonly string[], needle: string): void {
    if (haystack.includes(needle)) { passed++; return }
    failures.push(`${name}\n    ${needle} missing from [${haystack.slice(0, 12).join(", ")}...]`)
}

// --- hover -------------------------------------------------------------
{
    const { document, cursor } = open(`const answer = 42\nprint(ans‸wer)\n`)
    const result = hover(analyzer.get(document), cursor)
    check("hover: const keeps its literal type", (result?.contents as { value: string }).value,
        "```tilua-hover\nanswer: 42\n```")
}
{
    const { document, cursor } = open(
        `declare v: string | nil\nif (v ~= nil) {\n    print(‸v)\n}\n`,
    )
    const result = hover(analyzer.get(document), cursor)
    check("hover: shows the narrowed type", (result?.contents as { value: string }).value,
        "```tilua-hover\nv: string\n```")
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.Posi‸tion)\n`)
    const result = hover(analyzer.get(document), cursor)
    check("hover: property of a Roblox class", (result?.contents as { value: string }).value,
        "```tilua-hover\nPosition: Vector3\n```")
}

// Declarations, not just uses. Scope analysis indexes these separately, and
// hovering them used to show nothing at all.
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)?.value
    }
    check("hover: a const declaration", hoverText(`const nu‸ms = [1, 2]\nprint(nums)\n`),
        "```tilua-hover\nconst nums: number[]\n```")
    check("hover: a let declaration", hoverText(`let cou‸nt = 1\nprint(count)\n`),
        "```tilua-hover\nlet count: number\n```")
    check("hover: a parameter",
        hoverText(`function f(x‸s: number[]): number {\n    return #xs\n}\n`),
        "```tilua-hover\n(parameter) xs: number[]\n```")
    check("hover: a function name",
        hoverText(`function first‸Two(xs: number[]): number {\n    return 1\n}\n`),
        "```tilua-hover\nfunction firstTwo(xs: number[]) => number\n```")
    check("hover: nothing on an operator", hoverText(`declare a: boolean\ndeclare b: number\nconst c = a a‸nd b\n`), undefined)
    check("hover: nothing on a parenthesis", hoverText(`print( ‸ 1)\n`), undefined)
    check("hover: an operand still has its own", hoverText(`declare a: boolean\ndeclare b: number\nconst c = ‸a and b\n`),
        "```tilua-hover\na: boolean\n```")
}
{
    const { document, cursor } = open(`const tot‸al = 1\nprint(total)\n`)
    const analysis = analyzer.get(document)
    check("references: from the declaration itself", references(analysis, cursor, true).length, 2)
    check("rename: from the declaration itself",
        Object.values(rename(analysis, cursor, "sum")?.changes ?? {})[0]?.length, 2)
}

// Keys, definitions and types. Each of these used to show nothing (or, for an
// object key, the whole object).
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    check("hover: an object literal key shows that property",
        hoverText(`const obj = { na‸me: "n", count: 2 }\nprint(obj)\n`), "(property) name: string")
    check("hover: a declared value",
        hoverText(`declare fo‸o: { bar: number }\n`), "declare foo: { bar: number }")
    check("hover: a declared function",
        hoverText(`declare function gre‸et(name: string): nil\n`), "declare function greet(name: string) => nil")
    check("hover: an overloaded declaration shows its own signature",
        hoverText(`declare function f(x: string): string\ndeclare function ‸f(x: number): number\n`),
        "declare function f(x: number) => number  (+1 overload)")
    check("hover: a mapped type's key",
        hoverText(`type M<T> = { [‸K in keyof T]: T[K] }\n`)?.startsWith("(type parameter) K in "), true)
    check("hover: an infer name", hoverText(`type R<T> = T extends () => infer ‸U ? U : never\n`), "(type parameter) infer U")
    check("hover: a use of an infer name", hoverText(`type R<T> = T extends () => infer U ? ‸U : never\n`), "(type parameter) infer U")
    check("hover: a type query resolves to the value's type",
        hoverText(`const d = { v: 1 }\nconst c: typ‸eof d = { v: 2 }\n`), "{ v: number }")
    check("hover: a type literal property",
        hoverText(`declare foo: { ba‸r: number, baz?: string }\n`), "(property) bar: number")
    check("hover: an optional type literal property",
        hoverText(`declare foo: { bar: number, ba‸z?: string }\n`), "(property) baz?: string")
    check("hover: a property name is not confused with a same-named type",
        hoverText(`type bar = string\ndeclare foo: { bar: ba‸r }\n`), "type bar = string")
    check("hover: a parameter in a function type",
        hoverText(`declare foo: (co‸unt: number) => string\n`), "(parameter) count: number")
    check("hover: a primitive type", hoverText(`const n: numb‸er = 1\n`), "type number")
    check("hover: an alias by reference",
        hoverText(`type Shape = { r: number }\nconst s: Sha‸pe = { r: 1 }\n`), "type Shape = { r: number }")
    check("hover: an alias by its own name",
        hoverText(`type Sha‸pe = { r: number }\n`), "type Shape = { r: number }")
    check("hover: a library type", hoverText(`const s: Servi‸ces = nil as any\n`)?.startsWith("type Services = "), true)
    check("hover: a generic parameter",
        hoverText(`type Box<T extends string> = { value: ‸T }\n`), "(type parameter) T extends string")
    // Which member comes first is the library's business, not this test's.
    check("hover: a long object type goes one member per line", (() => {
        const lines = (hoverText(`print(ma‸th)\n`) ?? "").split("\n")
        return lines[0] === "math: {"
            && lines[1].startsWith("    ") && lines[1].trimEnd().endsWith(",")
            && lines[2].startsWith("    ")
    })(), true)
}

// --- semantic tokens ---------------------------------------------------
// Each token decoded back to `word:type.modifier...`, so a test can say what a
// word should be coloured as.
{
    const { semanticTokens, semanticTokensLegend } = await import("../src/features/semanticTokens.js")
    const tokensOf = (src: string): string[] => {
        const { document } = open(src)
        const data = semanticTokens(analyzer.get(document)).data
        const lines = document.getText().split("\n")
        const out: string[] = []
        let line = 0
        let character = 0
        for (let i = 0; i < data.length; i += 5) {
            line += data[i]
            character = data[i] === 0 ? character + data[i + 1] : data[i + 1]
            const word = lines[line].slice(character, character + data[i + 2])
            const type = semanticTokensLegend.tokenTypes[data[i + 3]]
            const modifiers = semanticTokensLegend.tokenModifiers.filter((_, bit) => data[i + 4] & (1 << bit))
            out.push([`${word}:${type}`, ...modifiers].join("."))
        }
        return out
    }

    const conditional = tokensOf(`type Ret<T> = T extends (...unknown) => infer R ? R : never\n`)
    contains("semantic: `extends` in a conditional is a keyword", conditional, "extends:keyword")
    contains("semantic: `type` declaring an alias is a keyword", conditional, "type:keyword")
    contains("semantic: the alias name", conditional, "Ret:type.declaration")
    contains("semantic: a type parameter's declaration", conditional, "T:typeParameter.declaration")
    contains("semantic: a type parameter's use", conditional, "T:typeParameter")
    contains("semantic: `infer` is a keyword", conditional, "infer:keyword")
    contains("semantic: the inferred name", conditional, "R:typeParameter.declaration")
    contains("semantic: a primitive type", conditional, "unknown:type.defaultLibrary")

    const call = tokensOf(`print(type(1))\n`)
    contains("semantic: `type(x)` in code is a call, not a keyword", call, "type:function.defaultLibrary")

    const declared = tokensOf(`declare function greet(name: string): nil\nconst d = { v: 1 }\nconst c: typeof d = d\n`)
    contains("semantic: a declared function's name", declared, "greet:function.declaration")
    contains("semantic: a declared function's parameter", declared, "name:parameter.declaration")
    contains("semantic: `declare` is a keyword", declared, "declare:keyword")
    contains("semantic: `typeof` in a type is a keyword", declared, "typeof:keyword")
    contains("semantic: the queried value is a variable", declared, "d:variable.readonly")
    contains("semantic: a const declaration", declared, "c:variable.declaration.readonly")

    const literal = tokensOf(`declare foo: { readonly bar: number, run: (x: number) => nil }\n`)
    contains("semantic: a readonly property in a type", literal, "bar:property.declaration.readonly")
    contains("semantic: a function-typed property is a method", literal, "run:method.declaration")

    const defaults = tokensOf(`const main = 1\nexport default main\nconst options = { default: 1 }\nprint(options.default)\n`)
    contains("semantic: `default` after `export` is a control keyword", defaults, "default:keyword.control")
    contains("semantic: a property named `default` is still a property", defaults, "default:property")
    check("semantic: reserved words are left to the grammar",
        defaults.some(t => t.startsWith("const:") || t.startsWith("export:")), false)

    // A quoted key is one Identifier whose span takes in the quotes: colouring
    // `name.length` characters stopped two short and left `y"` to the grammar,
    // which painted the tail as the string it looks like.
    const quoted = tokensOf(`type Keys = { "key": number, "my key": string, plain: boolean }\n`)
    contains(`semantic: a quoted key is coloured over its quotes`, quoted, `"key":property.declaration`)
    contains(`semantic: a quoted key with a space, too`, quoted, `"my key":property.declaration`)
    contains(`semantic: an unquoted key is unchanged`, quoted, "plain:property.declaration")

    const classes = tokensOf(`declare class Dog extends Instance { Bark: (self: Dog) => () }\nconst d: Dog = nil as any\nconst p: Vector3 = Vector3.new()\n`)
    contains("semantic: `class` in a declaration is a keyword", classes, "class:keyword")
    contains("semantic: the class name", classes, "Dog:class.declaration")
    contains("semantic: a superclass", classes, "Instance:class")
    contains("semantic: a class used as a type", classes, "Vector3:class")

    const modifiers = tokensOf(`class A {\n    private static count = 0\n    public get size(): number { return 1 }\n}\n`)
    contains("semantic: `private` before a member is a keyword", modifiers, "private:keyword")
    contains("semantic: `static` after `private` is still a keyword", modifiers, "static:keyword")
    contains("semantic: `public` before an accessor, and the accessor's `get`", modifiers, "public:keyword")
    contains("semantic: `get` after `public` is still a keyword", modifiers, "get:keyword")
}

// --- classes -------------------------------------------------------------
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    check("classes: typeof an Instance is \"Instance\"",
        hoverText(`const ReplicatedStorage = game:GetService("ReplicatedStorage")\nconst ty‸pe = typeof(ReplicatedStorage)\n`),
        `const type: "Instance"`)
    check("classes: a class shows what it extends and adds",
        hoverText(`const p: Pa‸rt = Instance.new("Part")\n`),
        "declare class Part extends FormFactorPart {\n    Shape: Enum.PartType,\n}")
    check("classes: an empty subclass",
        hoverText(`const s: ReplicatedSto‸rage = game:GetService("ReplicatedStorage")\n`),
        "declare class ReplicatedStorage extends Instance {}")
    check("classes: hovering a declaration",
        hoverText(`declare class Do‸g extends Instance { Bark: (self: Dog) => () }\n`),
        "declare class Dog extends Instance {\n    Bark: (self: Dog) => (),\n}")
    const diagnosticsOf = (src: string): string[] => diagnostics(analyzer.get(open(src).document)).map(d => d.message)
    check("classes: a table is not an Instance, and a sibling class is not either",
        diagnosticsOf(`const a: Instance = { Name: "x" }\nconst b: Part = game:GetService("Players")\n`),
        ["Type '{ Name: string }' is not assignable to 'Instance', missing Changed, ClassName, GetPropertyChangedSignal and 47 more",
            "Type 'Players' is not assignable to 'Part', missing GetPivot, PivotTo, Anchored and 72 more"])
    const { document, cursor } = open(`const part = Instance.new("Part")\npart.‸`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("classes: inherited members complete", labels, "Name")
    contains("classes: own members complete", labels, "Shape")
    check("classes: a callback parameter is typed from the event",
        hoverText(`game:GetService("Players").PlayerAdded:Connect(function(pla‸yer) {})\n`), "(parameter) player: Player")
    check("classes: a qualified enum type",
        hoverText(`const m: Enum.Mate‸rial = Enum.Material.Neon\n`), "declare class Enum.Material extends EnumItem {}")
    const enumLabels = (src: string): string[] => {
        const opened = open(src)
        return completion(analyzer, opened.document, opened.cursor).map(i => i.label)
    }
    contains("classes: `Enum.` lists the enums", enumLabels(`const e = Enum.‸`), "KeyCode")
    contains("classes: `Enum.KeyCode.` lists its items", enumLabels(`const k = Enum.KeyCode.‸`), "Space")
    check("classes: operators follow metamethods",
        hoverText(`const po‸s = Vector3.new() + Vector3.new(0, 1, 0)\n`), "const pos: Vector3")
    const symbols = documentSymbols(analyzer.get(open(`declare class Dog extends Instance {}\n`).document))
    check("classes: outline", symbols.map(s => [s.name, s.detail]), [["Dog", "extends Instance"]])
}

// --- completion where people actually type ------------------------------
// A member access alone on a line is a syntax error, and that is exactly where
// `obj.` gets typed. These used to fall back to listing the globals.
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    check("completion: `obj.` on its own line after a multi-line object",
        labelsAt(`const obj = {\n    a: 1\n}\nobj.‸`), ["a"])
    // A `private` member is offered only where it can be reached.
    const account = "class Account {\n    owner = \"a\"\n    private balance = 0\n"
    const reach = (labels: string[]) => ["owner", "balance"].map(name => labels.includes(name))
    check("completion: a private member is hidden outside its class",
        reach(labelsAt(`${account}}\nconst a = new Account()\na.‸`)), [true, false])
    check("completion: a private member is offered inside its class",
        reach(labelsAt(`${account}    function peek(): number {\n        return this.‸\n    }\n}\n`)), [true, true])
    const members = ["constructor", "function", "static", "private"]
    const offered = (labels: string[]) => members.map(name => labels.includes(name))
    check("completion: member keywords in a class body",
        offered(labelsAt(`class A {\n    con‸\n}\n`)), [true, true, true, true])
    check("completion: member keywords between members",
        offered(labelsAt(`class A {\n    x = 1\n    ‸\n    function f() {}\n}\n`)), [true, true, true, true])
    check("completion: member keywords in a class expression",
        offered(labelsAt(`const B = class {\n    ‸\n}\n`)), [true, true, true, true])
    check("completion: after a modifier, no constructor and no repeat",
        offered(labelsAt(`class A {\n    private ‸\n}\n`)), [false, true, true, false])
    check("completion: a method body is code, not members",
        labelsAt(`class A {\n    function f() {\n        ‸\n    }\n}\n`).includes("constructor"), false)
    check("completion: `--@` offers the directives",
        labelsAt(`--@‸\nconst x = 1\n`), ["@tilua-nocheck", "@tilua-ignore", "@tilua-expect-error"])
    check("completion: `-- @tilua-ex` still offers them",
        labelsAt(`const y = 2\n-- @tilua-ex‸\nconst x = 1\n`).length, 3)
    contains("completion: `game.` alone on a line",labelsAt(`game.‸\n`), "Workspace")
    contains("completion: a chain `game.Workspace.`", labelsAt(`game.Workspace.‸\n`), "Name")
    contains("completion: `:` on a string reaches the string library", labelsAt(`const s = "abc"\ns:‸\n`), "upper")
    check("completion: nothing, rather than globals, when a type has no members",
        labelsAt(`const xs = [1, 2]\nxs.‸\n`), [])
    check("completion: `..` is concatenation, not member access",
        labelsAt(`const alpha = 1\nprint("a" ..‸)\n`).includes("alpha"), true)
    const maybe = `type Part = { Name: string, Destroy: (self: Part) => () }\ndeclare part: Part | nil\n`
    check("completion: `?.` offers the members of the non-nil type",
        labelsAt(`${maybe}part?.‸\n`).sort(), ["Destroy", "Name"])
    check("completion: `?:` offers its methods",
        labelsAt(`${maybe}part?:‸\n`), ["Destroy"])
    contains("completion: past a `?.` in a chain", labelsAt(`game?.Workspace.‸\n`), "Name")
    const indexed = `type R = { RemoteMap: { Char: number }, ClassMap: { Sans: string } }\nconst t = { x: 1, y: 2 }\n`
    check("completion: the keys a string can index, in a type, a constraint and a value", [
        labelsAt(`${indexed}type K = R["‸"]\n`).sort(),
        labelsAt(`${indexed}function f<K extends R["RemoteMap"]["‸"]>(k: K) {}\n`),
        labelsAt(`${indexed}print(t["‸"])\n`).sort(),
    ], [["ClassMap", "RemoteMap"], ["Char"], ["x", "y"]])
    check("completion: a broken field leaves the rest of the object",
        labelsAt(`const Config = {\n    a: 1,\n    b: ,\n    c: "x"\n    d: 2,\n}\nConfig.‸\n`).sort(), ["a", "b", "c", "d"])
}

// --- the keys a type says an object literal should have -----------------
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const shape = `type Shape = { width: number, height: number, label?: string }\n`
    check("completion: the keys a `satisfies` type names",
        labelsAt(`${shape}const s = {\n    ‸\n} satisfies Shape\n`).sort(), ["height", "label", "width"])
    check("completion: the keys an annotation names, minus those already written",
        labelsAt(`${shape}const s: Shape = {\n    width: 1,\n    ‸\n}\n`).sort(), ["height", "label"])
    check("completion: the keys a parameter names",
        labelsAt(`${shape}declare function take(s: Shape): ()\ntake({\n    ‸\n})\n`).sort(), ["height", "label", "width"])
    check("completion: a mapped type's keys",
        labelsAt(`type Names = "a" | "b"\nconst m = {\n    ‸\n} satisfies { [K in Names]: number }\n`).sort(), ["a", "b"])
    check("completion: a nested literal's keys",
        labelsAt(`type Outer = { inner: { deep: number } }\nconst o: Outer = {\n    inner: {\n        ‸\n    }\n}\n`), ["deep"])
    check("completion: a value is a value, not a key",
        labelsAt(`${shape}const w = 5\nconst s: Shape = {\n    width: ‸\n}\n`).includes("height"), false)
}

// --- a string argument that depends on another argument --------------------
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const head = [
        `const Rows = {`,
        `    a: [`,
        `        { Page: "Bones", Skills: ["Bonespam", "Bonewall"] },`,
        `        { Page: "Fire", Skills: ["Geyser"] },`,
        `    ],`,
        `} as const`,
        `type Row = (typeof Rows)["a"][number]`,
        `declare function get<P extends Row["Page"]>(`,
        `    page: P,`,
        `    skill: Extract<Row, { Page: P }>["Skills"][number],`,
        `): boolean`,
        "",
    ].join("\n")
    check("completion: the page, then that page's skills", [
        labelsAt(`${head}get("‸")\n`).sort(),
        labelsAt(`${head}get("Bones", "‸")\n`).sort(),
        labelsAt(`${head}get("Fire", "‸")\n`).sort(),
    ], [
        ["Bones", "Fire"],
        ["Bonespam", "Bonewall"],
        ["Geyser"],
    ])
}

// --- what hoisting makes visible before its declaration --------------------
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const file = (head: string) =>
        `${head}function later(): number {\n    return 1\n}\nconst afterConst = 2\n`

    const top = labelsAt(file("const v = ‸\n"))
    check("completion: a function declared below is offered; a later const is not",
        [top.includes("later"), top.includes("afterConst")], [true, false])

    const body = labelsAt(file("function first() {\n    return ‸\n}\n"))
    check("completion: inside a function body, the module's later names are too",
        [body.includes("later"), body.includes("afterConst")], [true, true])
}

// --- the methods arrays and strings answer to ------------------------------
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const arrayMethods = labelsAt(`const names = ["a"]\nnames:‸\n`)
    check("completion: an array's methods", [
        arrayMethods.includes("filter"), arrayMethods.includes("map"), arrayMethods.includes("join"),
        // Only with `:` — `names.filter` reads a key the table does not have.
        labelsAt(`const names = ["a"]\nnames.‸\n`).length,
    ], [true, true, true, 0])

    const stringMethods = labelsAt(`declare text: string\ntext:‸\n`)
    check("completion: a string's methods, Luau's own and the language's", [
        stringMethods.includes("upper"), stringMethods.includes("gsub"),
        stringMethods.includes("trim"), stringMethods.includes("startsWith"),
        // `string.char` is a function of the library, not a method of a string.
        stringMethods.includes("char"),
    ], [true, true, true, true, false])
}

// --- the keys an index signature spells out --------------------------------
{
    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const names = `type Names = "GTFrisk" | "XTFrisk"\n`
    check("completion: the keys a finite index signature covers",
        labelsAt(`${names}const perClass = {\n    ‸\n} as const satisfies { [Names]: () => () }\n`).sort(),
        ["GTFrisk", "XTFrisk"])
    // `[string]` names no key in particular, so nothing replaces the ordinary
    // suggestions there.
    check("completion: `[string]` spells out no keys",
        labelsAt(`const m = {\n    ‸\n} satisfies { [string]: number }\n`).includes("print"), true)
}

// --- a ternary's parts, and each line of an overload set -----------------
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    const ternary = `declare c: boolean\nconst a = 1\nconst b = 2\n`
    check("hover: the parts of `cond ? a : b`", [
        hoverText(`${ternary}const v = ‸c ? a : b\n`),
        hoverText(`${ternary}const v = c ? ‸a : b\n`),
        hoverText(`${ternary}const v = c ? a : ‸b\n`),
    ], ["c: boolean", "a: 1", "b: 2"])

    const overloads = `export function f(x: "a"): number\nexport function f(x: "b"): string\nexport function f(x) {\n    return nil\n}\nprint(f("a"))\n`
    check("hover: each line of an overload set shows its own signature, the body's line the whole set", [
        hoverText(overloads.replace(`function f(x: "a")`, `function ‸f(x: "a")`)),
        hoverText(overloads.replace(`function f(x: "b")`, `function ‸f(x: "b")`)),
        hoverText(overloads.replace("function f(x)", "function ‸f(x)")),
    ], [
        `function f(x: "a") => number`,
        `function f(x: "b") => string`,
        `function f: ((x: "a") => number) & ((x: "b") => string)`,
    ])

    const { document } = open(overloads)
    const analysis = analyzer.get(document)
    const tokenLines = new Set<number>()
    const data = semanticTokens(analysis).data
    for (let i = 0, line = 0; i < data.length; i += 5) {
        line += data[i]
        if (data[i + 2] === 1) tokenLines.add(line)
    }
    check("semantic tokens: every line of the set colours its name",
        [0, 1, 2].every(line => tokenLines.has(line)), true)
}

// --- inside a template ---------------------------------------------------
// `${...}` is parsed from its own text; its nodes used to sit at the top of an
// imaginary file, so nothing in one could be pointed at.
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    check("hover: a name inside an interpolation",
        hoverText(`const count = 3\nconst s = \`n = \${cou‸nt}\`\n`), "count: 3")
    check("hover: the second interpolation of a template",
        hoverText(`const a = 1\nconst b = "x"\nconst s = \`\${a} \${‸b}\`\n`), `b: "x"`)
    check("hover: nothing on the text around it",
        hoverText(`const count = 3\nconst s = \`n‸ = \${count}\`\n`), undefined)
}

// --- unknown type names, and values offered where a type says what fits ---
{
    const messagesFor = (src: string): string[] =>
        diagnostics(analyzer.get(open(src).document)).map(d => d.message)
    check("types: a name nothing declares", [
        messagesFor(`const x: Nope = 1\n`),
        messagesFor(`function f(a: NoParam): NoReturn {\n    return a\n}\n`),
        messagesFor(`const p: Part = Instance.new("Part")\nconst m: Enum.Material = Enum.Material.Grass\ntype Mine = { a: number }\nconst mine: Mine = { a: 1 }\nfunction g<T>(v: T): T {\n    return v\n}\n`),
        messagesFor(`type Cased = Uppercase<"a">\nconst c: Cased = "A"\n`),
    ], [
        ["Cannot find name 'Nope'"],
        ["Cannot find name 'NoParam'", "Cannot find name 'NoReturn'"],
        [],
        [],
    ])

    const valuesAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const mode = `type Mode = "fast" | "slow"\n`
    check("completion: the values a type admits, where one is written", [
        valuesAt(`${mode}function f(m: Mode = "‸") {}\n`).sort(),
        valuesAt(`${mode}const m: Mode = "‸"\n`).sort(),
        valuesAt(`${mode}type Cfg = { mode: Mode }\nconst c: Cfg = { mode: "‸" }\n`).sort(),
    ], [["fast", "slow"], ["fast", "slow"], ["fast", "slow"]])
}

// --- keywords where they are valid, and `...` ---------------------------
{
    // `typeof` is a function at runtime as well, so it belongs in a value
    // position too — only the type-position cases look for it.
    const keywordsAt = (src: string, wanted = ["keyof", "infer", "extends", "as", "satisfies"]): string[] => {
        const { document, cursor } = open(src)
        const set = new Set(wanted)
        return completion(analyzer, document, cursor).map(i => i.label).filter(l => set.has(l)).sort()
    }
    const typeKeywords = ["keyof", "typeof", "infer", "extends"]
    check("completion: a type position offers the type keywords",
        keywordsAt(`const x: ‸\n`, typeKeywords), ["extends", "infer", "keyof", "typeof"])
    check("completion: a type argument too",
        keywordsAt(`type B = Partial<‸>\n`, typeKeywords), ["extends", "infer", "keyof", "typeof"])
    check("completion: `extends` after a type parameter's name", keywordsAt(`function f<K ‸>() end\n`), ["extends"])
    check("completion: `as` and `satisfies` after an expression",
        keywordsAt(`const v = { a: 1 } ‸\n`), ["as", "satisfies"])
    check("completion: and nowhere else", [keywordsAt(`const a = 1\n‸\n`), keywordsAt(`function f() {\n    ‸\n}\n`)], [[], []])

    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    check("hover: `...` is what the function declared it takes",
        hoverText(`function f(...: number) {\n    print(‸...)\n}\n`), "(vararg) ...: number")
    check("hover: an undeclared `...`",
        hoverText(`function f(...) {\n    print(‸...)\n}\n`), "(vararg) ...: any")
}

// --- hover inside a destructuring pattern --------------------------------
// A shorthand key and the name it declares have the same span, so the cursor
// lands on the key: it used to show nothing at all.
{
    const hoverText = (src: string): string | undefined => {
        const { document, cursor } = open(src)
        return (hover(analyzer.get(document), cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    const t = `declare t: { RemoteMap: number, other: string, nested: { deep: number } }\n`
    check("hover: a shorthand key is the binding it declares",
        hoverText(`${t}const { Remote‸Map } = t\n`), "const RemoteMap: number")
    check("hover: a renamed key is the property it reads",
        hoverText(`${t}const { Remote‸Map: renamed } = t\n`), "(property) RemoteMap: number")
    check("hover: and the name it is renamed to is the binding",
        hoverText(`${t}const { RemoteMap: ren‸amed } = t\n`), "const renamed: number")
    check("hover: a nested shorthand key",
        hoverText(`${t}const { nested: { de‸ep } } = t\n`), "const deep: number")
    check("hover: a destructured parameter",
        hoverText(`function f({ a‸ }: { a: number }) {}\n`), "(parameter) a: number")
    check("hover: a destructuring assignment target",
        hoverText(`${t}let other = ""\n{ oth‸er } = t\n`), "let other: string")
    check("hover: the rest of a pattern, without what it did not take",
        hoverText(`${t}const { RemoteMap, ...re‸st } = t\n`),
        "const rest: { nested: { deep: number }, other: string }")
}

// --- services and directives ---------------------------------------------
{
    const serviceEdit = (src: string, label: string) => {
        const { document, cursor } = open(src)
        const item = completion(analyzer, document, cursor).find(i => i.label === label && i.additionalTextEdits)
        return item?.additionalTextEdits?.map(e => [e.range.start.line, e.range.start.character, e.newText])
    }
    check("services: a service declares itself above the code",
        serviceEdit(`print(1)\nPlay‸\n`, "Players"), [[0, 0, `const Players = game:GetService("Players")\n\n`]])
    check("services: after the services already declared",
        serviceEdit(`const RS = game:GetService("ReplicatedStorage")\nprint(RS)\nPlay‸\n`, "Players"),
        [[1, 0, `const Players = game:GetService("Players")\n`]])
    check("services: not once it is declared",
        serviceEdit(`const Players = game:GetService("Players")\nPlay‸\n`, "Players"), undefined)

    const diagnosticsOf = (src: string): string[] => diagnostics(analyzer.get(open(src).document)).map(d => d.message)
    check("directives: ignore, expect-error and nocheck", [
        diagnosticsOf(`--@tilua-ignore\nconst a: number = "x"\n`),
        diagnosticsOf(`--@tilua-expect-error\nconst a: number = 1\n`),
        diagnosticsOf(`--@tilua-nocheck\nconst a: number = "x"\nnope()\n`),
        diagnosticsOf(`--@tilua-nocheck\nconst a = \n`).length,
    ], [[], ["Unused '@tilua-expect-error' directive"], [], 1])
    check("undeclared: a name nothing declares, and not an assigned global or a declare", [
        diagnosticsOf(`print(typo, game)
const t = Missing.x
`),
        diagnosticsOf(`counter = 1
print(counter)
declare later: number
print(later)
`),
    ], [["Cannot find name 'typo'", "Cannot find name 'Missing'"], []])
}

// --- modules -----------------------------------------------------------
// Real files in a temp folder, since imports resolve against the file system.
{
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")
    const { importDefinition } = await import("../src/features/imports.js")

    const root = mkdtempSync(join(tmpdir(), "tilua-modules-"))
    mkdirSync(join(root, "shared"))
    writeFileSync(join(root, "shared", "shapes.tilua"), [
        "export type Point = { x: number, y: number }",
        "export const ORIGIN: Point = { x: 0, y: 0 }",
        "export function distance(a: Point, b: Point): number {",
        "    return a.x - b.x",
        "}",
        "export default ORIGIN",
        "",
        "",
        "",
    ].join("\n"))

    // Two files exporting the same name, for the auto-import case below. They
    // go in with the other fixtures because the directory listing is cached
    // for a few seconds once anything has asked for it.
    writeFileSync(join(root, "exportsM1.tilua"), "export const m = 1\n")
    writeFileSync(join(root, "exportsM2.tilua"), "export const m = 2\n")

    const modules = new Analyzer({ libs: testLibs })
    const file = (name: string, text: string) => {
        const index = text.indexOf("‸")
        const clean = index < 0 ? text : text.slice(0, index) + text.slice(index + 1)
        writeFileSync(join(root, name), clean)
        const document = TextDocument.create(pathToFileURL(join(root, name)).href, "tilua", 1, clean)
        return { document, cursor: document.positionAt(Math.max(index, 0)) }
    }
    const hoverText = (document: TextDocument, cursor: Position): string | undefined =>
        (hover(modules.get(document), cursor)?.contents as { value: string } | undefined)?.value

    {
        const { document, cursor } = file("main.tilua",
            `import origin, { ORIGIN, distance, Point } from "./shared/shapes"\nconst p: Point = { x: 1, y: 2 }\nprint(dist‸ance(p, ORIGIN), origin)\n`)
        check("modules: an imported function has its real type, not any",
            hoverText(document, cursor)?.includes("=> number"), true)
        check("modules: a valid import has no diagnostics", diagnostics(modules.get(document)).map(d => d.message), [])
    }
    {
        const { document } = file("broken.tilua",
            `import { nope } from "./shared/shapes"\nimport x from "./missing"\nprint(nope, x)\n`)
        const messages = diagnostics(modules.get(document)).map(d => d.message)
        contains("modules: a missing module is reported", messages, "Cannot find module './missing'")
        contains("modules: a missing export is reported", messages, "Module './shared/shapes' has no exported member 'nope'")
    }
    {
        const { document } = file("typed.tilua", `import { ORIGIN } from "./shared/shapes"\nconst wrong: string = ORIGIN\n`)
        check("modules: an import is type-checked", diagnostics(modules.get(document)).length, 1)
    }
    {
        const edits = (name: string, text: string, label: string) => {
            const { document, cursor } = file(name, text)
            const item = completion(modules, document, cursor).find(i => i.label === label && i.additionalTextEdits)
            return item?.additionalTextEdits?.map(e => [e.range.start.line, e.range.start.character, e.newText])
        }
        check("auto-import: another file's export adds its import above the code",
            edits("auto1.tilua", `print(1)\ndist‸\n`, "distance"), [[0, 0, `import { distance } from "./shared/shapes"\n\n`]])
        check("auto-import: after the imports already there",
            edits("auto2.tilua", `import { x } from "./other"\nprint(x)\nORIG‸\n`, "ORIGIN"), [[1, 0, `import { ORIGIN } from "./shared/shapes"\n`]])
        check("auto-import: joins an import of the same file",
            edits("auto3.tilua", `import { ORIGIN } from "./shared/shapes"\nprint(ORIGIN)\ndist‸\n`, "distance"), [[0, 15, ", distance"]])
        check("auto-import: a type in a type position",
            edits("auto4.tilua", `const p: Poi‸ = { x: 1, y: 2 }\n`, "Point"), [[0, 0, `import { Point } from "./shared/shapes"\n\n`]])
        check("auto-import: not for a name already in scope",
            edits("auto5.tilua", `const distance = 1\ndist‸\n`, "distance"), undefined)

        // A name used but not declared is a global binding like any other, and
        // it is exactly the name you are about to import — so it must not count
        // as already in scope. It did, which left the import unoffered from the
        // moment the name appeared anywhere in the file.
        const used = file("auto7.tilua", `print(m)\nm‸\n`)
        check("auto-import: still offered for a name the file uses but never declares",
            completion(modules, used.document, used.cursor)
                .filter(i => i.label === "m" && i.additionalTextEdits).length, 2)

        // Two files exporting the same name: both are offered, each saying
        // which file it would import from. Offering only one would silently
        // pick a file on the author's behalf.
        const { document, cursor } = file("auto6.tilua", `m‸\n`)
        const offers = completion(modules, document, cursor)
            .filter(i => i.label === "m" && i.additionalTextEdits)
        check("auto-import: every file exporting a name is offered, not just one", [
            offers.length,
            offers.map(i => i.labelDetails?.description).sort(),
            offers.map(i => i.detail).sort(),
        ], [
            2,
            ["./exportsM1", "./exportsM2"],
            [`import { m } from "./exportsM1"`, `import { m } from "./exportsM2"`],
        ])
    }
    {
        const { document, cursor } = file("paths.tilua", `import { ORIGIN } from "./‸"\n`)
        const labels = completion(modules, document, cursor).map(i => i.label)
        contains("modules: path completion lists folders", labels, "shared/")
        contains("modules: path completion lists modules without the extension", labels, "main")
        check("modules: a file is not offered to itself", labels.includes("paths"), false)
    }
    {
        const { document, cursor } = file("nested.tilua", `import { ORIGIN } from "./shared/‸"\n`)
        contains("modules: path completion inside a folder", completion(modules, document, cursor).map(i => i.label), "shapes")
    }
    {
        const { document, cursor } = file("names.tilua", `import { ORIGIN, ‸ } from "./shared/shapes"\n`)
        const labels = completion(modules, document, cursor).map(i => i.label)
        contains("modules: exported values inside the braces", labels, "distance")
        contains("modules: exported types inside the braces", labels, "Point")
        check("modules: names already imported are not offered again", labels.includes("ORIGIN"), false)
    }
    {
        const { document, cursor } = file("jump.tilua", `import { dist‸ance } from "./shared/shapes"\nprint(distance)\n`)
        const location = importDefinition(modules, modules.get(document), cursor)
        check("modules: definition jumps into the other module", location?.uri.endsWith("shapes.tilua"), true)
        check("modules: ...to the exported declaration", location?.range.start, { line: 2, character: 16 })
    }
    {
        const { document, cursor } = file("member.tilua", `import origin from "./shared/shapes"\norigin.‸\n`)
        contains("modules: members of a default import", completion(modules, document, cursor).map(i => i.label), "x")
    }
    {
        const { document, cursor } = file("namespace.tilua", `import * as Shapes from "./shared/shapes"\nShapes.‸\n`)
        const labels = completion(modules, document, cursor).map(i => i.label)
        contains("modules: `import * as` completes the module's exports", labels, "distance")
        contains("modules: including its default", labels, "default")
    }
    {
        const { document, cursor } = file("namespace-type.tilua",
            `import * as Shapes from "./shared/shapes"\nconst p: Shapes.Point = Shapes.ORIGIN\nprint(Sha‸pes.distance(p, p))\n`)
        check("modules: a namespace's exported type and values check", diagnostics(modules.get(document)).map(d => d.message), [])
        check("modules: hovering the namespace", /^```tilua-hover\nShapes: \{[\s\S]*readonly distance/.test(hoverText(document, cursor) ?? ""), true)
    }
    {
        const { document, cursor } = file("type-import.tilua",
            `import type { Point, distance } from "./shared/shapes"\nconst p: Point = { x: 1, y: 2 }\nprint(dist‸ance)\n`)
        check("modules: a type-only import used as a value is an error", diagnostics(modules.get(document)).map(d => d.message),
            ["'distance' is imported with 'import type' and can only be used as a type"])
        check("modules: hovering a type-only import", hoverText(document, { line: 0, character: 22 })?.includes("(type import) distance"), true)
        check("modules: type-only imports are not offered as values",
            completion(modules, document, { line: 2, character: 6 }).map(i => i.label).includes("distance"), false)
        void cursor
    }
    {
        const { document } = file("assign-import.tilua", `import { ORIGIN } from "./shared/shapes"\nORIGIN = nil as any\n`)
        check("modules: assigning to an import is an error",
            diagnostics(modules.get(document)).map(d => d.message), ["Cannot assign to 'ORIGIN' — it is an import"])
    }
    {
        // Export lists, a renamed export, and `export *`.
        writeFileSync(join(root, "barrel.tilua"), [
            `export * from "./shared/shapes"`,
            `const five = 5`,
            `type Pair = [number, number]`,
            `export { five, Pair, five as cinq }`,
            "",
        ].join("\n"))
        const { document } = file("fromBarrel.tilua",
            `import { distance, ORIGIN, five, cinq, Pair } from "./barrel"\nconst pair: Pair = [1, 2]\nprint(distance(ORIGIN, ORIGIN), five, pair)\nconst wrong: string = cinq\n`)
        check("modules: export lists and `export *` carry their types",
            diagnostics(modules.get(document)).map(d => d.message), ["Type '5' is not assignable to 'string'"])
        const location = importDefinition(modules, modules.get(document), { line: 0, character: 10 })
        check("modules: definition follows `export *` to the declaring module", location?.uri.endsWith("shapes.tilua"), true)
    }
    {
        const { document } = file("badExports.tilua",
            `export { nothing }\nexport { nope } from "./shared/shapes"\nexport * from "./gone"\n`)
        const messages = diagnostics(modules.get(document)).map(d => d.message)
        contains("modules: exporting a name that does not exist", messages, "Cannot find name 'nothing' to export")
        contains("modules: re-exporting a missing member", messages, "Module './shared/shapes' has no exported member 'nope'")
        contains("modules: re-exporting from a missing module", messages, "Cannot find module './gone'")
    }
    {
        // A module that does not exist yet, and then does.
        const { document } = file("later.tilua", `import { soon } from "./notYet"\nprint(soon)\n`)
        contains("modules: before the module exists",
            diagnostics(modules.get(document)).map(d => d.message), "Cannot find module './notYet'")
        writeFileSync(join(root, "notYet.tilua"), `export const soon = 1\n`)
        check("modules: creating it re-checks the importer", diagnostics(modules.get(document)).map(d => d.message), [])
    }
    {
        const { document, cursor } = file("typeImport.tilua",
            `import { Po‸int } from "./shared/shapes"\nconst p: Point = { x: 1, y: 2 }\n`)
        check("modules: a type-only import hovers as its type",
            hoverText(document, cursor)?.includes("type Point = { x: number, y: number }"), true)
        const typed = file("typePosition.tilua", `import { Point } from "./shared/shapes"\nconst q: Po‸ = { x: 1, y: 2 }\n`)
        contains("modules: an imported type is offered in a type position",
            completion(modules, typed.document, typed.cursor).map(i => i.label), "Point")
    }
    {
        // Editing the imported module invalidates the importer's cached result.
        const { document } = file("watch.tilua", `import { ORIGIN } from "./shared/shapes"\nconst n: { x: number, y: number } = ORIGIN\n`)
        check("modules: before the export changes", diagnostics(modules.get(document)).length, 0)
        writeFileSync(join(root, "shared", "shapes.tilua"), `export const ORIGIN = "moved"\n`)
        check("modules: after it changes, the importer is re-checked", diagnostics(modules.get(document)).length, 1)
    }
}

// --- call arguments --------------------------------------------------
// An argument is checked against its parameter, a generic one against its
// constraint, and a string argument offers what its parameter accepts.
{
    const messagesOf = (src: string): string[] => diagnostics(analyzer.get(open(src).document)).map(d => d.message)

    check("arguments: a string where a number is expected", messagesOf(`wait("")\n`),
        ["Argument of type '\"\"' is not assignable to parameter of type 'number | nil'"])
    check("arguments: a literal outside a literal union",
        messagesOf(`declare function pick(kind: "a" | "b"): nil\npick("c")\n`),
        ["Argument of type '\"c\"' is not assignable to parameter of type '\"a\" | \"b\"'"])
    check("arguments: a generic parameter is checked against its constraint",
        messagesOf(`game.GetService(game, "")\n`).some(m => m.startsWith("Argument of type '\"\"' is not assignable to parameter of type '\"")), true)
    check("arguments: the same through a method call",
        messagesOf(`game:GetService("Nope")\n`).length, 1)
    check("arguments: correct calls stay clean",
        messagesOf(`wait()\nwait(1)\nprint(game:GetService("Players"), game.GetService(game, "Workspace"))\n`), [])

    const labelsAt = (src: string): string[] => {
        const { document, cursor } = open(src)
        return completion(analyzer, document, cursor).map(i => i.label)
    }
    const services = labelsAt(`game.GetService(game, "‸")\n`)
    contains("completion: a string argument offers what its parameter accepts", services, "ReplicatedStorage")
    check("completion: and nothing else — no variables inside quotes", services.includes("print"), false)
    contains("completion: through a method call, mid-word", labelsAt(`game:GetService("Rep‸")\n`), "ReplicatedStorage")
    check("completion: a string with no expected values offers nothing", labelsAt(`print("‸")\n`), [])
}

// --- import cycles -----------------------------------------------------
// A cycle is broken by letting one side see the other unfinished; a second
// pass then fills in what that left as `any`.
{
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { dirname, join } = await import("node:path")
    const { pathToFileURL } = await import("node:url")

    const root = mkdtempSync(join(tmpdir(), "tilua-cycles-"))
    const files: Record<string, string> = {
        "values/a.tilua": `import { fromB } from "./b"\nexport function fromA(): number {\n    return 1\n}\nconst wrongA: number = fromB()\nprint(wrongA)\n`,
        "values/b.tilua": `import { fromA } from "./a"\nexport function fromB(): string {\n    return "b"\n}\nconst wrongB: string = fromA()\nprint(wrongB)\n`,
        "types/a.tilua": `import { B } from "./b"\nexport type A = { name: string, b: B | nil }\nconst wrongA: A = { name: 1, b: nil }\nprint(wrongA)\n`,
        "types/b.tilua": `import { A } from "./a"\nexport type B = { count: number, a: A | nil }\nconst wrongB: B = { count: "x", a: nil }\nprint(wrongB)\n`,
        "star/a.tilua": `export * from "./b"\nexport const ONE = 1\n`,
        "star/b.tilua": `export * from "./a"\nexport const TWO = 2\n`,
        "star/main.tilua": `import { ONE, TWO } from "./a"\nconst bad1: string = ONE\nconst bad2: string = TWO\nprint(bad1, bad2)\n`,
        // What the first pass alone got wrong: exports of the far side inferred
        // from the near side.
        "back/a.tilua": `import { useA, AliasOfA, takesA } from "./b"\nexport function fromA(): number {\n    return 1\n}\nexport type A = { name: string }\nconst viaValue: string = useA\nconst viaAlias: AliasOfA = { name: 1 }\nconst viaFunction: string = takesA({ name: "x" })\nprint(viaValue, viaAlias, viaFunction)\n`,
        "back/b.tilua": `import { fromA, A } from "./a"\nexport const useA = fromA()\nexport type AliasOfA = A\nexport function takesA(a: A): number {\n    return 1\n}\n`,
        // A cycle the opened file is not part of: b <-> c.
        "deep/main.tilua": `import { doubled } from "./b"\nconst wrong: string = doubled\nprint(wrong)\n`,
        "deep/b.tilua": `import { derived } from "./c"\nexport const base = 1\nexport const doubled = derived\n`,
        "deep/c.tilua": `import { base } from "./b"\nexport const derived = base\n`,
    }
    for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
    }
    const messagesOf = (analyzer: Analyzer, path: string): string[] => diagnostics(analyzer.get(
        TextDocument.create(pathToFileURL(join(root, path)).href, "tilua", 1, files[path]))).map(d => d.message)
    const fresh = (): Analyzer => new Analyzer({ libs: testLibs })

    {
        const cycles = fresh()
        check("cycles: values, the first file opened", messagesOf(cycles, "values/a.tilua"), ["Type 'string' is not assignable to 'number'"])
        check("cycles: values, the second", messagesOf(cycles, "values/b.tilua"), ["Type 'number' is not assignable to 'string'"])
    }
    check("cycles: values, opened the other way round", messagesOf(fresh(), "values/b.tilua"), ["Type 'number' is not assignable to 'string'"])
    {
        const cycles = fresh()
        check("cycles: types, one side", messagesOf(cycles, "types/a.tilua").length, 1)
        check("cycles: types, the other", messagesOf(cycles, "types/b.tilua").length, 1)
    }
    check("cycles: `export *` both ways", messagesOf(fresh(), "star/main.tilua"),
        ["Type '1' is not assignable to 'string'", "Type '2' is not assignable to 'string'"])
    check("cycles: an export inferred back from the importing file is not `any`",
        messagesOf(fresh(), "back/a.tilua"),
        [
            "Type 'number' is not assignable to 'string'",
            "Type '{ name: number }' is not assignable to '{ name: string }', 'name' is number, not string",
            "Type 'number' is not assignable to 'string'",
        ])
    check("cycles: a cycle the opened file is not part of", messagesOf(fresh(), "deep/main.tilua"),
        ["Type '1' is not assignable to 'string'"])

    rmSync(root, { recursive: true, force: true })
}

// --- projects ----------------------------------------------------------
// Real folders: configs, installed type libraries, aliases and a sourcemap.
{
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs")
    const { tmpdir } = await import("node:os")
    const { dirname, join } = await import("node:path")
    const { fileURLToPath, pathToFileURL } = await import("node:url")

    const root = mkdtempSync(join(tmpdir(), "tilua-project-"))
    const put = (path: string, text: string): void => {
        mkdirSync(dirname(join(root, path)), { recursive: true })
        writeFileSync(join(root, path), text)
    }
    // The type libraries, installed the way a project would have them.
    for (const name of ["lua", "roblox"]) {
        const installed = fileURLToPath(new URL(`../node_modules/@tilua-types/${name}/`, import.meta.url))
        for (const file of ["package.json", "index.d.tilua"]) {
            put(`node_modules/@tilua-types/${name}/${file}`, readFileSync(join(installed, file), "utf8"))
        }
    }

    put("game/tilua.config.json", JSON.stringify({ types: ["roblox"], paths: { "@shared/*": ["shared/*"] }, sourceMap: "sourcemap.json" }))
    put("game/shared/util.tilua", "export const VALUE = 1\n")
    put("game/sourcemap.json", JSON.stringify({
        name: "Game", className: "DataModel", children: [
            { name: "ReplicatedStorage", className: "ReplicatedStorage", children: [
                { name: "Remotes", className: "Folder" },
                { name: "Main", className: "ModuleScript", filePaths: ["main.luau"] },
            ] },
        ],
    }))
    put("game/lite/tilua.config.json", JSON.stringify({ types: ["luau"], paths: {}, sourceMap: null }))
    put("dup/tilua.config.json", "{}")
    put("dup/tilua.config.jsonc", "{}")
    put("missing/tilua.config.json", JSON.stringify({ types: ["nope"], paths: {}, sourceMap: null }))

    const projects = new Analyzer()
    const openFile = (path: string, text: string): TextDocument => {
        put(path, text)
        return TextDocument.create(pathToFileURL(join(root, path)).href, "tilua", 1, text)
    }

    const main = projects.get(openFile("game/main.tilua", [
        `import { VALUE } from "@shared/util"`,
        `const remotes: Folder = script.Parent.Remotes`,
        `const value: number = VALUE`,
        `const wrong: string = game.ReplicatedStorage.Remotes`,
        "",
    ].join("\n")))
    check("projects: a file takes its folder's config", main.project.config?.path.endsWith(join("game", "tilua.config.json")), true)
    const mainMessages = diagnostics(main).map(d => d.message)
    check("projects: types, a paths alias and the sourcemap all apply — only the deliberate error remains",
        mainMessages.length === 1 && mainMessages[0].endsWith("is not assignable to 'string'"), true)

    const lite = projects.get(openFile("game/lite/x.tilua", "print(game)\n"))
    check("projects: a nested config replaces the outer one",
        [lite.project.config?.path.endsWith(join("lite", "tilua.config.json")), lite.types.aliases.has("Part"), lite.types.aliases.has("Partial")],
        [true, false, true])

    const loose = projects.get(TextDocument.create(
        pathToFileURL(join(dirname(root), `tilua-no-config-${Date.now()}`, "x.tilua")).href, "tilua", 1, "print(1)\n"))
    check("projects: a file no config covers has only the language's own types",
        [loose.project.config, [...loose.types.aliases.keys()].sort().join(" ")],
        [undefined, "Exclude Extract Falsy Mutable NonNullable Omit Parameters Partial Pick Readonly Record Required ReturnType Truthy"])

    check("projects: two configs in one folder are reported on both",
        projects.get(openFile("dup/x.tilua", "")).project.problems.length, 2)
    check("projects: a missing type library is reported",
        projects.get(openFile("missing/x.tilua", "")).project.problems.map(problem => problem.message),
        ["Cannot find type library '@tilua-types/nope'. Install it with: npm i -D @tilua-types/nope"])

    // Editing a config re-checks the files under it.
    put("game/lite/tilua.config.json", JSON.stringify({ types: ["roblox"], paths: {}, sourceMap: null }))
    check("projects: editing a config re-checks its files",
        projects.get(openFile("game/lite/x.tilua", "print(game)\n")).types.aliases.has("Part"), true)

    const labelsAt = (path: string, text: string): string[] => {
        const index = text.indexOf("‸")
        const document = openFile(path, text.slice(0, index) + text.slice(index + 1))
        return completion(projects, document, document.positionAt(index)).map(i => i.label)
    }
    contains("projects: a paths alias is offered as an import path",
        labelsAt("game/c1.tilua", `import { VALUE } from "@‸"\n`), "@shared/")
    contains("projects: and what is inside it",
        labelsAt("game/c2.tilua", `import { VALUE } from "@shared/‸"\n`), "util")

    rmSync(root, { recursive: true, force: true })
}

// --- diagnostics -------------------------------------------------------
{
    const { document } = open(`const n: number = "text"\n`)
    const found = diagnostics(analyzer.get(document))
    check("diagnostics: one assignability error", found.length, 1)
    // The analyzer reports on the whole declaration, not the initializer.
    check("diagnostics: on the declaration", found[0]?.range,
        { start: { line: 0, character: 0 }, end: { line: 0, character: 24 } })
}
{
    const { document } = open(`const x = \nprint(`)
    const found = diagnostics(analyzer.get(document))
    check("diagnostics: recovers from syntax errors", found.length > 0, true)
}
{
    const { document } = open(`const x = 1\nx = 2\n`)
    const found = diagnostics(analyzer.get(document))
    check("diagnostics: assigning to a const", found.some(d => d.code === "const-assign"), true)
}

// --- navigation --------------------------------------------------------
{
    const source = `const total = 1\nprint(tot‸al)\nprint(total)\n`
    const { document, cursor } = open(source)
    const analysis = analyzer.get(document)
    check("definition: jumps to the declaration", definition(analysis, cursor)?.range,
        { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } })
    check("references: declaration plus both uses",
        references(analysis, cursor, true).length, 3)
    check("references: uses only", references(analysis, cursor, false).length, 2)
    const edit = rename(analysis, cursor, "sum")
    check("rename: edits every site", Object.values(edit?.changes ?? {})[0]?.length, 3)
    check("rename: rejects an invalid name", rename(analysis, cursor, "1bad"), null)
}

// --- completion --------------------------------------------------------
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.‸)\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: members after `.`", labels, "Position")
    contains("completion: inherited members too", labels, "Name")
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\npart:‸\n`)
    const items = completion(analyzer, document, cursor)
    const labels = items.map(i => i.label)
    contains("completion: methods after `:`", labels, "IsA")
    check("completion: `:` offers only methods",
        labels.includes("Position"), false)
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\nprint(part.Pos‸)\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: works mid-word", labels, "Position")
}
{
    const { document, cursor } = open(`const localName = 1\nprint(loc‸)\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: locals in scope", labels, "localName")
    contains("completion: globals from the definitions", labels, "game")
}
{
    const { document, cursor } = open(`type Alias = number\nconst v: Al‸ = 1\n`)
    const labels = completion(analyzer, document, cursor).map(i => i.label)
    contains("completion: aliases in type position", labels, "Alias")
    contains("completion: primitives in type position", labels, "string")
    check("completion: no values in type position", labels.includes("game"), false)
}

// --- signature help ----------------------------------------------------
{
    const { document, cursor } = open(
        `function add(a: number, b: string): number {\n    return a\n}\nadd(1, ‸)\n`,
    )
    const help = signatureHelp(analyzer, document, cursor)
    check("signature help: label", help?.signatures[0]?.label, "(a: number, b: string) => number")
    check("signature help: active parameter", help?.activeParameter, 1)
}
{
    const { document, cursor } = open(`const part = Instance.new("Part")\npart:IsA(‸)\n`)
    const help = signatureHelp(analyzer, document, cursor)
    check("signature help: `:` skips self",
        help ? help.activeParameter === 1 : null, true)
}

// --- records and discriminants -------------------------------------------
{
    const head = [
        `const ReplicatedStorage = game:GetService("ReplicatedStorage")`,
        `const Remotes = {`,
        `    Char: ReplicatedStorage:FindFirstChild("Char") as RemoteEvent,`,
        `    GetSettings: ReplicatedStorage:FindFirstChild("GetSettings") as RemoteFunction,`,
        `}`,
        `function scan() {`,
        `    for (RemoteName, Remote in pairs(Remotes)) {`,
    ].join("\n") + "\n"
    const labelsAt = (src: string): string[] => {
        const opened = open(src)
        return completion(analyzer, opened.document, opened.cursor).map(i => i.label)
    }
    const hoverAt = (src: string): string | undefined => {
        const opened = open(src)
        return (hover(analyzer.get(opened.document), opened.cursor)?.contents as { value: string } | undefined)
            ?.value.replace(/^```tilua-hover\n|\n```$/g, "")
    }
    check("records: a pairs key is the union of the property names",
        hoverAt(head + `        print(Remote‸Name)\n    }\n}\n`), `RemoteName: "Char" | "GetSettings"`)
    check("records: testing the key narrows the value",
        hoverAt(head + `        if (RemoteName == "GetSettings") { print(Rem‸ote) }\n    }\n}\n`), "Remote: RemoteFunction")
    check("records: a compared string offers the keys",
        labelsAt(head + `        if (RemoteName == "‸") {}\n    }\n}\n`), ["Char", "GetSettings"])
    check("records: ...while the line is still being typed",
        labelsAt(head + `        if (RemoteName == "‸\n    }\n}\n`), ["Char", "GetSettings"])
    check("records: an unclosed argument string offers its values too",
        labelsAt(`const P = game:GetService("Play‸\n`).includes("Players"), true)
    check("records: an indexer holds only its value type",
        diagnostics(analyzer.get(open(`const m: { [string]: Vector3 } = { a: game:GetService("ReplicatedStorage"):FindFirstChild("a") }\n`).document))
            .map(d => d.message),
        ["Type '{ a: Instance | nil }' is not assignable to '{ [string]: Vector3 }'"])
}

// --- symbols -----------------------------------------------------------
{
    const { document } = open(
        `type Point = { x: number }\nconst origin = 1\nconst function go(): nil {\n    return nil\n}\n`,
    )
    const names = documentSymbols(analyzer.get(document)).map(s => s.name)
    check("symbols: outline", names, ["Point", "origin", "go"])
}

// --- caching -----------------------------------------------------------
{
    const document = TextDocument.create("file:///cache.tilua", "tilua", 1, "const a = 1\n")
    check("analysis is cached per version", analyzer.get(document) === analyzer.get(document), true)
}

// -----------------------------------------------------------------------
// --- classes -----------------------------------------------------------
{
    const CLASS = [
        "class Animal {",
        "    name: string",
        "    static count = 0",
        "    constructor(name: string) {",
        "        this.name = name",
        "    }",
        "    function speak(): string {",
        "        return this.name",
        "    }",
        "    get label(): string {",
        "        return this.name",
        "    }",
        "}",
        "class Dog extends Animal {",
        "    breed = \"corgi\"",
        "    constructor(name: string) {",
        "        super(name)",
        "    }",
        "    function fetch(): boolean {",
        "        return true",
        "    }",
        "}",
        "const d = new Dog(\"Rex\")",
        "",
        "",
        "",
    ].join("\n")

    const labels = (source: string): string[] => {
        const opened = open(source)
        return completion(analyzer, opened.document, opened.cursor).map(i => i.label)
    }

    check("completion: an instance offers its members, the inherited ones, and its class",
        labels(`${CLASS}d.‸\n`).sort(), ["ClassObject", "breed", "fetch", "label", "name", "speak"])
    check("completion: `:` offers only what takes the instance",
        labels(`${CLASS}d:‸\n`).sort(), ["fetch", "speak"])
    check("completion: the class table offers its statics, `new` and the class it extends",
        labels(`${CLASS}Dog.‸\n`).sort(), ["ParentClass", "count", "new"])
    contains("completion: `new` offers the classes in scope", labels(`${CLASS}const z = new ‸\n`), "Dog")
    check("completion: `this` is the instance being written", labels([
        "class A {",
        "    x: number",
        "    constructor() {",
        "        this.x = 1",
        "    }",
        "    function m() {",
        "        this.‸",
        "    }",
        "}",
    ].join("\n")).sort(), ["ClassObject", "m", "x"])

    // A class is shown the way it is written, not as a `declare class`.
    {
        const { document, cursor } = open(CLASS.replace("class Dog", "class Do‸g"))
        check("hover: a class reads as it is written",
            (hover(analyzer.get(document), cursor)?.contents as { value: string }).value,
            "```tilua-hover\nclass Dog extends Animal {\n    breed: string\n    fetch: (this: Dog) => boolean\n}\n```")
    }
    {
        const { document, cursor } = open(`${CLASS}const y: An‸imal = d\n`)
        check("hover: naming a class in a type shows the class",
            (hover(analyzer.get(document), cursor)?.contents as { value: string }).value,
            "```tilua-hover\nclass Animal {\n    name: string\n    speak: (this: Animal) => string\n    readonly label: string\n}\n```")
    }

    // The outline lists a class and what is in it.
    {
        const { document } = open(CLASS)
        const symbols = documentSymbols(analyzer.get(document))
        const dog = symbols.find(s => s.name === "Dog")
        check("symbols: a class is an outline entry with its members under it",
            [dog?.kind, dog?.detail, dog?.children?.map(c => c.name)],
            [SymbolKind.Class, "extends Animal", ["breed", "constructor", "fetch"]])
    }

    // Go to definition on a construction lands on the class.
    {
        const { document, cursor } = open(`${CLASS}const q = new D‸og("a")\n`)
        const target = definition(analyzer.get(document), cursor)
        check("definition: `new Dog(...)` goes to the class",
            target && (target as { range: { start: { line: number } } }).range.start.line,
            CLASS.split("\n").findIndex(line => line.startsWith("class Dog")))
    }

    {
        const { document } = open(CLASS)
        check("diagnostics: a plain class reports nothing", diagnostics(analyzer.get(document)).map(d => d.message), [])
    }

    // A generic class: the arguments reach hover and completion.
    {
        const BOX = [
            "class Box<T> {",
            "    value: T",
            "    constructor(value: T) {",
            "        this.value = value",
            "    }",
            "    function get(): T {",
            "        return this.value",
            "    }",
            "}",
            "",
            "",
            "",
        ].join("\n")
        const { document, cursor } = open(`${BOX}const n‸ = new Box("a")\n`)
        check("hover: a generic class is shown at the argument it was made with",
            (hover(analyzer.get(document), cursor)?.contents as { value: string }).value,
            "```tilua-hover\nconst n: Box<string>\n```")
        const got = open(`${BOX}const n = new Box(1)\nconst g‸ot = n:get()\n`)
        check("hover: a generic class's method answers at that argument",
            (hover(analyzer.get(got.document), got.cursor)?.contents as { value: string }).value,
            "```tilua-hover\nconst got: number\n```")
        const annotated = open(`${BOX}const which: Box<number> = new Box(1)\nconst wrong: Box<number> = new Box("a")\n`)
        check("diagnostics: a generic class is not another instantiation of itself",
            diagnostics(analyzer.get(annotated.document)).map(d => d.message),
            ["Type 'Box<string>' is not assignable to 'Box<number>', 'value' is string, not number"])
    }

    // A class written as a value takes the name it is bound to.
    {
        const source = [
            "const Counter = class {",
            "    n = 0",
            "    function bump(): number {",
            "        this.n += 1",
            "        return this.n",
            "    }",
            "}",
            "const c = new Counter()",
            "",
            "",
            "",
        ].join("\n")
        const { document } = open(source)
        check("diagnostics: a class written as a value reports nothing",
            diagnostics(analyzer.get(document)).map(d => d.message), [])
        const opened = open(source.replace("const c =", "const c‸ ="))
        check("hover: a class written as a value is known by the name it is bound to",
            (hover(analyzer.get(opened.document), opened.cursor)?.contents as { value: string }).value,
            "```tilua-hover\nconst c: Counter\n```")
    }
}

// --- hover, a level at a time ------------------------------------------
{
    /** Every reading of the type under the cursor, shortest first. */
    const levels = (source: string): string[] => {
        const { document, cursor } = open(source)
        const out: string[] = []
        for (let depth = 0; depth < 6; depth++) {
            const answer = hover(analyzer.get(document), cursor, depth)
            if (!answer) break
            out.push((answer.contents as { value: string }).value.replace(/```tilua-hover\n|\n```/g, ""))
            if (!answer.canExpand) break
        }
        return out
    }

    // The example everything else follows: an alias for a primitive is shown
    // as the alias, and opens to what it stands for.
    check("hover: an alias opens to what it stands for",
        levels("type A = number\nconst B‸: A = 1\n"), ["const B: A", "const B: number"])

    // An object keeps its name whether or not it was annotated, so both read
    // the same way and open the same way.
    check("hover: an object alias opens to its members",
        levels("type P = { x: number }\nconst q‸: P = { x: 1 }\n"),
        ["const q: P", "const q: { x: number }"])
    check("hover: an inferred one too",
        levels("type P = { x: number }\ndeclare make: () => P\nconst q‸ = make()\n"),
        ["const q: P", "const q: { x: number }"])

    // One level at a time: the names inside wait their turn.
    check("hover: the names inside open on the next level", levels([
        "type Inner = { n: number }",
        "type Outer = { i: Inner, name: string }",
        `const o‸: Outer = { i: { n: 1 }, name: "a" }`,
        "",
    ].join("\n")), [
        "const o: Outer",
        "const o: { i: Inner, name: string }",
        "const o: { i: { n: number }, name: string }",
    ])

    check("hover: an alias inside an array opens with it",
        levels("type Inner = { n: number }\ndeclare xs: Inner[]\nconst a‸ = xs\n"),
        ["const a: Inner[]", "const a: { n: number }[]"])

    // A class is what it is called, not a shorthand for its shape.
    check("hover: a class stays its name",
        levels("declare class Part { Size: number }\ndeclare p: Part\nconst q‸ = p\n"), ["const q: Part"])

    // A type that names itself stops rather than unrolling.
    check("hover: a type that names itself opens once",
        levels("type Node = { next: Node | nil, n: number }\ndeclare head: Node\nconst h‸ = head\n"),
        ["const h: Node", "const h: { n: number, next: Node | nil }"])

    check("hover: nothing to open is nothing to offer", levels("const n‸ = 1\n"), ["const n: 1"])

    // A branded type is an intersection, and reads as one.
    check("hover: a branded type opens to the brand", levels([
        `type UserId = string & { readonly __brand: "UserId" }`,
        "declare u: UserId",
        "const v‸ = u",
        "",
    ].join("\n")), [
        "const v: UserId",
        `const v: string & { readonly __brand: "UserId" }`,
    ])
}

for (const failure of failures) console.log(`FAIL ${failure}`)
console.log(`\n${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
