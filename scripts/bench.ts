/** Simulates a project of N open files and measures a `publishAll` sweep —
 *  what the server does on every keystroke.
 *
 *  The project is made inside this repo so `@tilua-types/roblox` resolves from its
 *  node_modules: the 1 MB type library is the whole point of the measurement. */
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { TextDocument } from "vscode-languageserver-textdocument"
import { Analyzer, pathKey } from "../src/analysis.js"
import { diagnostics } from "../src/features/diagnostics.js"

const FILES = Number(process.env.FILES ?? 10)
const repo = join(fileURLToPath(new URL(".", import.meta.url)), "..")
const root = join(repo, ".bench-tmp")
rmSync(root, { recursive: true, force: true })
mkdirSync(join(root, "src"), { recursive: true })
writeFileSync(join(root, "tilua.config.json"), JSON.stringify({ types: ["lua", "roblox"], paths: {}, sourceMap: null }))

const paths: string[] = []
for (let i = 0; i < FILES; i++) {
    const path = join(root, "src", `mod${i}.tilua`)
    writeFileSync(path, [
        i > 0 ? `import { value${i - 1} } from "./mod${i - 1}"` : "",
        `export const value${i} = ${i}`,
        `export type Shape${i} = { n: number, s: string }`,
        `const part = nil as any as Part`,
        `const name = part.Name`,
        `function use${i}(shape: Shape${i}): number { return shape.n }`,
        `print(use${i}({ n: ${i}, s: "x" }), name${i > 0 ? `, value${i - 1}` : ""})`,
    ].join("\n"))
    paths.push(path)
}

let docs: TextDocument[] = []
// Kept by path, as the server keeps its open documents.
const byPath = new Map(paths.map((p, i) => [pathKey(p), i]))
const analyzer = new Analyzer({ openDocument: p => { const i = byPath.get(pathKey(p)); return i === undefined ? undefined : docs[i] } })
docs = paths.map(p => TextDocument.create(pathToFileURL(p).href, "tilua", 1, readFileSync(p, "utf8")))

function sweep(): number {
    const start = performance.now()
    analyzer.sweep(() => { for (const document of docs) diagnostics(analyzer.get(document)) })
    return performance.now() - start
}

const first = analyzer.get(docs[0])
console.log(`type libraries loaded: ${first.project.config ? "yes" : "NO"}` +
    `  problems: ${first.project.problems.length}  deps: ${first.dependencies.size}`)
console.log(`cold sweep:    ${sweep().toFixed(0)} ms`)
const warm = Array.from({ length: 5 }, () => sweep())
console.log(`warm sweeps:   ${warm.map(n => n.toFixed(0) + " ms").join(", ")}`)

// One keystroke in one file, then a sweep — the real per-keystroke cost.
const edits: number[] = []
for (let i = 0; i < 5; i++) {
    docs[0] = TextDocument.create(docs[0].uri, "tilua", 2 + i, docs[0].getText() + "\n")
    edits.push(sweep())
}
console.log(`per keystroke: ${edits.map(n => n.toFixed(0) + " ms").join(", ")}`)

rmSync(root, { recursive: true, force: true })
