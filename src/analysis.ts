/**
 * Analysis cache, projects, and the module graph behind `import`.
 *
 * The three parser passes are cheap (single-digit milliseconds for a normal
 * file) but not free, and every LSP request wants the same result for the same
 * document version — so each document is analyzed once per version and the
 * result is reused by hover, definition, completion and the rest.
 *
 * Nothing is built in. A file belongs to the project of the nearest
 * `tilua.config.json`: the type libraries it names, its `paths` aliases, and
 * its sourcemap's instance tree. A file no config covers gets no types at all.
 *
 * An import is resolved to a file, that file is analyzed the same way, and its
 * exports become the importing file's types. Open documents are read in
 * preference to disk, so an import sees unsaved edits. A cached result is only
 * reused while every file it read — the modules it imports, its config, type
 * libraries and sourcemap — still has the text it was analyzed against.
 */
import { readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
    parse, parseWithRecovery, analyzeScopes, analyzeTypes, moduleExports, getBinding,
    findConfig, resolveTypeLibraries, moduleCandidates, sourceMapTypes,
    type Program, type ScopeAnalysis, type TypeAnalysis, type ParseError, type ModuleExports,
    type Binding, type Identifier, type Type, type TiluaConfig, type ConfigProblem, type ProjectHost,
    type SourceMapTypes, type Directives,
} from "@tilua/parser"
import type { TextDocument } from "vscode-languageserver-textdocument"
import { membersOf } from "./features/members.js"

export interface Analysis {
    readonly uri: string
    readonly version: number
    readonly source: string
    readonly program: Program
    readonly parseErrors: readonly ParseError[]
    /** `--@tilua-nocheck` / `--@tilua-ignore` / `--@tilua-expect-error`. */
    readonly directives: Directives
    readonly scopes: ScopeAnalysis
    readonly types: TypeAnalysis
    /** Every file this analysis read — imported modules, its config, type
     *  libraries, sourcemap — with the text it read, or `undefined` for a file
     *  it looked for and did not find. How a cached result tells that something
     *  changed, appeared or vanished under it. */
    readonly dependencies: ReadonlyMap<string, string | undefined>
    /** The project the file belongs to. */
    readonly project: Project
}

export interface Project {
    /** The config that applies to the file, or `undefined` when none does. */
    readonly config?: TiluaConfig
    /** The types came from `AnalyzerOptions.libs`, not from a config. */
    readonly fixed: boolean
    /** What is wrong with the config, a type library it names, or its sourcemap. */
    readonly problems: readonly ConfigProblem[]
}

export interface AnalyzerOptions {
    /** Analyze every file against these definitions instead of the ones its
     *  `tilua.config.json` names — for tests and for embedding the server. */
    libs?: readonly Program[]
    /** The open document for a file path, if there is one. */
    openDocument?: (path: string) => TextDocument | undefined
}

/** Names a file may use undeclared: whatever the definitions declare. */
function globalsOf(libs: readonly Program[]): string[] {
    const names = new Set<string>()
    for (const lib of libs) {
        for (const statement of lib.body.statements) {
            if (statement.type === "DeclareStatement") names.add(statement.name)
        }
    }
    return [...names]
}

/** The binding a node names, whether it *uses* the binding or *declares* it.
 *
 *  Scope analysis indexes the two differently: every use is in `bindingOf`,
 *  but a declaration only appears as its binding's `declarationNode`. Asking
 *  `bindingOf` alone is why hovering `const x` — as opposed to a later `x` —
 *  used to show nothing. */
export function bindingOfNode(analysis: Analysis, node: object): Binding | undefined {
    const used = getBinding(analysis.scopes, node as Identifier)
    if (used) return used
    return declarationIndex(analysis).get(node)
}

const declarationIndexes = new WeakMap<Analysis, Map<object, Binding>>()

function declarationIndex(analysis: Analysis): Map<object, Binding> {
    let index = declarationIndexes.get(analysis)
    if (!index) {
        index = new Map()
        for (const binding of analysis.scopes.bindings.values()) {
            if (binding.declarationNode) index.set(binding.declarationNode, binding)
        }
        declarationIndexes.set(analysis, index)
    }
    return index
}

// --------------------------------------------------------------------------
// Paths
// --------------------------------------------------------------------------

/** A file URI's path, or `undefined` for anything that is not a file. */
export function pathOfUri(uri: string): string | undefined {
    if (!uri.startsWith("file:")) return undefined
    try {
        return fileURLToPath(uri)
    } catch {
        return undefined
    }
}

export function uriOfPath(path: string): string {
    return pathToFileURL(path).href
}

/** Paths compare case-insensitively on Windows, where editors and the file
 *  system disagree about drive-letter case. */
export function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b)
}

function pathKey(path: string): string {
    const normalized = resolve(path)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

/** What an import of a module still being analyzed up the chain sees, when
 *  there is nothing better yet: its names read as `any`. */
const CYCLE: ModuleExports = { values: new Map(), types: new Map(), partial: true }

/**
 * One analysis of a module and everything it imports.
 *
 * An import cycle can only be broken by letting one side see the other before
 * it is finished — as `any`. A value exported from the far side and inferred
 * from the near side then comes back as `any` too. So a run that met a cycle
 * goes once more: the modules it analyzed are redone, and where an import
 * meets a module mid-analysis it reads that module's exports from the first
 * pass instead of `any`.
 */
interface Run {
    /** Modules an import reached while they were still being analyzed. */
    readonly cycles: Set<string>
    /** Modules analyzed in this run — the ones a second pass redoes. */
    readonly analyzed: Set<string>
    /** Exports from the first pass, read in place of `any` in the second. */
    readonly provisional: Map<string, ModuleExports>
}

// --------------------------------------------------------------------------
// Analyzer
// --------------------------------------------------------------------------

interface Module {
    analysis: Analysis
    exports: ModuleExports
}

/** Everything a folder's files are analyzed with. */
interface Context {
    readonly project: Project
    /** The type libraries, then the sourcemap's tree. */
    readonly libs: readonly Program[]
    readonly globals: readonly string[]
    readonly sourceMap?: SourceMapTypes
    /** Every file read to build this, with what it held. */
    readonly reads: ReadonlyMap<string, string | undefined>
}

const NO_PROJECT: Context = { project: { fixed: false, problems: [] }, libs: [], globals: [], reads: new Map() }

export class Analyzer {
    private readonly fixed?: Context
    private readonly openDocument?: (path: string) => TextDocument | undefined
    private readonly cache = new Map<string, Analysis>()
    /** Imported modules, by path key. */
    private readonly modules = new Map<string, Module>()
    /** Project contexts, by folder. */
    private readonly contexts = new Map<string, Context>()
    /** Parsed type libraries, by path — reparsed only when the text changes. */
    private readonly libraries = new Map<string, { source: string; program?: Program; problem?: ConfigProblem }>()
    /** Sourcemaps turned into types, by path, with what they were built from. */
    private readonly sourceMaps = new Map<string, { text: string; libraries: string; result: ReturnType<typeof sourceMapTypes> }>()
    /** The analysis run in progress, if any. */
    private run: Run | undefined

    constructor(options: AnalyzerOptions = {}) {
        this.openDocument = options.openDocument
        if (options.libs) {
            this.fixed = {
                project: { fixed: true, problems: [] },
                libs: options.libs,
                globals: globalsOf(options.libs),
                reads: new Map(),
            }
        }
    }

    /** Analyze `document`, reusing the previous result while neither it nor
     *  anything it read has changed. */
    get(document: TextDocument): Analysis {
        const cached = this.cache.get(document.uri)
        const source = document.getText()
        if (cached && cached.version === document.version && cached.source === source && this.isFresh(cached)) {
            return cached
        }
        const analysis = this.analyze(document.uri, document.version, source)
        this.cache.set(document.uri, analysis)
        return analysis
    }

    /** Analyze source text that is not a tracked document — used by
     *  completion, which analyzes a speculatively edited copy of the file. */
    analyze(uri: string, version: number, source: string): Analysis {
        const path = pathOfUri(uri)
        if (!path) return this.analyzeModule(uri, version, source, new Set())
        const key = pathKey(path)
        return this.resolvingCycles(key, () => {
            const analysis = this.analyzeModule(uri, version, source, new Set([key]))
            return { result: analysis, exports: () => this.exportsFrom(analysis, new Set([key])) }
        })
    }

    forget(uri: string): void {
        this.cache.delete(uri)
    }

    /** The project a file belongs to. */
    projectOf(uri: string): Project {
        return this.contextFor(pathOfUri(uri)).project
    }

    /** The file an import in `fromUri` names: a relative path, or a `paths`
     *  alias from the file's config. */
    resolveModulePath(fromUri: string, specifier: string): string | undefined {
        const from = pathOfUri(fromUri)
        if (!from) return undefined
        return this.candidatesFor(from, specifier).find(candidate => this.readFile(candidate) !== undefined)
    }

    /** What the module at `path` exports, analyzing it if need be. */
    exportsAt(path: string): ModuleExports | undefined {
        return this.resolvingCycles(pathKey(path), () => {
            const exports = this.exportsOf(path, new Set())
            return { result: exports, exports: () => exports }
        })
    }

    /** The analysis of the module at `path`, analyzing it if need be. */
    moduleAt(path: string): Analysis | undefined {
        this.exportsAt(path)
        return this.modules.get(pathKey(path))?.analysis
    }

    /** What was read from a path last time, and what the file system said
     *  about it then. A missing file is remembered too, as the `-1` stamp. */
    private readonly files = new Map<string, { mtimeMs: number; size: number; text: string | undefined }>()

    /** What the file system said about each path during the sweep going on
     *  now, or `undefined` outside one. */
    private stampsThisSweep?: Map<string, { mtimeMs: number; size: number }>

    /** Runs one sweep over the open files, during which each path is `stat`ed
     *  at most once.
     *
     *  Re-checking every open file asks about the same handful of type
     *  libraries and modules once per file — thousands of `stat` calls over a
     *  project of any size. A sweep is synchronous, so nothing on disk can move
     *  in the middle of one and the first answer stands for the rest of it.
     *  Outside a sweep every path is read afresh, so a file written and then
     *  asked about is seen. */
    sweep<T>(run: () => T): T {
        // A nested call belongs to the sweep already running.
        if (this.stampsThisSweep) return run()
        this.stampsThisSweep = new Map()
        try {
            return run()
        } finally {
            this.stampsThisSweep = undefined
        }
    }

    private stamp(path: string): { mtimeMs: number; size: number } {
        const known = this.stampsThisSweep?.get(path)
        if (known) return known
        // `-1` stands for "not a file we can read" — missing, or a directory.
        let stamp = { mtimeMs: -1, size: -1 }
        try {
            const stats = statSync(path)
            if (stats.isFile()) stamp = { mtimeMs: stats.mtimeMs, size: stats.size }
        } catch {
            // Not there; the -1 stamp says so.
        }
        this.stampsThisSweep?.set(path, stamp)
        return stamp
    }

    /** A file's text: the open document if there is one, else the disk.
     *
     *  Freshness is checked against every dependency of every open file on
     *  every keystroke, so this is on the hot path — and a project's type
     *  library is a megabyte. Re-reading that each time, and then comparing it
     *  character by character, was most of what made a real project slow. The
     *  file is only read again when its size or mtime moves, and until then
     *  the *same string* comes back, so the comparison in `isFresh` is a
     *  pointer test rather than a scan of a megabyte. */
    readFile(path: string): string | undefined {
        const open = this.openDocument?.(path)
        if (open) return open.getText()

        const { mtimeMs, size } = this.stamp(path)
        const cached = this.files.get(path)
        if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.text

        let text: string | undefined
        if (mtimeMs >= 0) {
            try {
                text = readFileSync(path, "utf8")
            } catch {
                text = undefined
            }
        }
        this.files.set(path, { mtimeMs, size, text })
        return text
    }

    private candidatesFor(from: string, specifier: string): string[] {
        return moduleCandidates(from, specifier, this.contextFor(from).project.config)
    }

    // ---------------------------------------------------------------- projects

    private contextFor(path: string | undefined): Context {
        if (this.fixed) return this.fixed
        if (!path) return NO_PROJECT
        const key = pathKey(dirname(path))
        const cached = this.contexts.get(key)
        if (cached && this.unchanged(cached.reads)) return cached
        const context = this.buildContext(path)
        this.contexts.set(key, context)
        return context
    }

    private buildContext(path: string): Context {
        const reads = new Map<string, string | undefined>()
        const host: ProjectHost = {
            readFile: file => {
                const text = this.readFile(file)
                reads.set(file, text)
                return text
            },
        }

        const lookup = findConfig(path, host)
        const problems: ConfigProblem[] = [...lookup.problems]
        const config = lookup.config
        if (!config) return { project: { fixed: false, problems }, libs: [], globals: [], reads }

        const libraries = resolveTypeLibraries(config, host)
        problems.push(...libraries.problems)
        const libs: Program[] = []
        for (const file of libraries.files) {
            const program = this.library(file, host, problems)
            if (program) libs.push(program)
        }

        let sourceMap: SourceMapTypes | undefined
        if (config.sourceMap) {
            const text = host.readFile(config.sourceMap)
            if (text === undefined) {
                problems.push({
                    file: config.path,
                    message: `Cannot find the sourceMap file ${config.sourceMap}`,
                    ...optionPosition(config, "sourceMap"),
                })
            } else {
                const result = this.sourceMap(config.sourceMap, text, libs, libraries.files)
                if (result.problem) problems.push({ file: config.sourceMap, message: result.problem, line: 1, column: 1 })
                sourceMap = result.types
                if (sourceMap) libs.push(sourceMap.program)
            }
        }

        return { project: { config, fixed: false, problems }, libs, globals: globalsOf(libs), sourceMap, reads }
    }

    /** A type library's definitions, parsed once per text. */
    private library(file: string, host: ProjectHost, problems: ConfigProblem[]): Program | undefined {
        const source = host.readFile(file)
        if (source === undefined) return undefined
        const key = pathKey(file)
        let entry = this.libraries.get(key)
        if (!entry || entry.source !== source) {
            try {
                entry = { source, program: parse(source) }
            } catch (error) {
                const { message, line, column } = error as { message: string; line?: number; column?: number }
                entry = {
                    source,
                    problem: { file, message: `Syntax error in type library: ${message.replace(/\s*\(\d+:\d+\)$/, "")}`, line, column },
                }
            }
            this.libraries.set(key, entry)
        }
        if (entry.problem) problems.push(entry.problem)
        return entry.program
    }

    /** A sourcemap's types, rebuilt only when it or the libraries change. */
    private sourceMap(path: string, text: string, libs: readonly Program[], files: readonly string[]): ReturnType<typeof sourceMapTypes> {
        const key = pathKey(path)
        const libraries = files.join("\n")
        const cached = this.sourceMaps.get(key)
        if (cached && cached.text === text && cached.libraries === libraries) return cached.result

        const aliases = aliasesOf(libs)
        const members = new Map<string, ReadonlySet<string>>()
        const result = sourceMapTypes(text, path, {
            classes: new Set(aliases.keys()),
            membersOf: className => {
                let names = members.get(className)
                if (!names) {
                    names = new Set(membersOf(aliases.get(className), aliases).map(member => member.name))
                    members.set(className, names)
                }
                return names
            },
        })
        this.sourceMaps.set(key, { text, libraries, result })
        return result
    }

    private unchanged(reads: ReadonlyMap<string, string | undefined>): boolean {
        for (const [file, text] of reads) if (this.readFile(file) !== text) return false
        return true
    }

    // ----------------------------------------------------------------- modules

    /** Run one analysis of `root` and everything it imports; if that met an
     *  import cycle, run it once more with the first pass's exports standing
     *  in for the `any` the cycle left (see `Run`). A call made while a run is
     *  already going is part of that run. */
    private resolvingCycles<T>(
        root: string,
        analyzeRoot: () => { result: T; exports: () => ModuleExports | undefined },
    ): T {
        if (this.run) return analyzeRoot().result
        const run: Run = { cycles: new Set(), analyzed: new Set(), provisional: new Map() }
        this.run = run
        try {
            const first = analyzeRoot()
            if (!run.cycles.size) return first.result

            for (const key of run.cycles) {
                const exports = key === root ? first.exports() : this.modules.get(key)?.exports
                if (exports && !exports.partial) run.provisional.set(key, exports)
            }
            // Anything the first pass analyzed may have read `any` through the
            // cycle, so all of it is redone.
            for (const key of run.analyzed) this.modules.delete(key)
            return analyzeRoot().result
        } finally {
            this.run = undefined
        }
    }

    /** A module's exports, from its analysis. */
    private exportsFrom(analysis: Analysis, importing: Set<string>): ModuleExports {
        // Re-exports (`export ... from`) resolve relative to this module.
        return moduleExports(analysis.program, analysis.scopes, analysis.types, specifier => {
            const next = this.resolveModulePath(analysis.uri, specifier)
            return next ? this.exportsOf(next, importing) : undefined
        })
    }

    /** `importing` holds every module on the current import chain, so an
     *  import back into one of them is recognized as a cycle. */
    private analyzeModule(uri: string, version: number, source: string, importing: Set<string>): Analysis {
        const path = pathOfUri(uri)
        const context = this.contextFor(path)
        // A file the sourcemap maps has its own `script`.
        const script = path ? context.sourceMap?.scriptFor(path) : undefined
        const libs = script ? [...context.libs, script] : context.libs
        const globals = script ? [...context.globals, "script"] : context.globals

        const { program, errors, directives } = parseWithRecovery(source)
        // A name nothing declares is only an error against type libraries:
        // without one, `print` itself is undeclared.
        const reportUndeclared = context.libs.length > 0
        const scopes = analyzeScopes(program, { builtinGlobals: [...globals], reportUndeclared })
        const dependencies = new Map(context.reads)
        const types = analyzeTypes(program, scopes, {
            libs,
            reportUnknownTypes: reportUndeclared,
            resolveModule: specifier => {
                if (!path) return undefined
                const candidates = this.candidatesFor(path, specifier)
                const target = candidates.find(candidate => this.readFile(candidate) !== undefined)
                if (!target) {
                    // Remember where it was looked for. Otherwise creating the
                    // file later would leave this module's "Cannot find module"
                    // — and its unresolved types — cached until its own text
                    // changed.
                    for (const candidate of candidates) dependencies.set(candidate, undefined)
                    return undefined
                }
                const exports = this.exportsOf(target, importing)
                dependencies.set(target, this.readFile(target))
                return exports
            },
        })
        return { uri, version, source, program, parseErrors: errors, directives, scopes, types, dependencies, project: context.project }
    }

    private exportsOf(path: string, importing: Set<string>): ModuleExports | undefined {
        const key = pathKey(path)
        if (importing.has(key)) {
            this.run?.cycles.add(key)
            return this.run?.provisional.get(key) ?? CYCLE
        }
        const source = this.readFile(path)
        if (source === undefined) return undefined
        const cached = this.modules.get(key)
        if (cached && cached.analysis.source === source && this.isFresh(cached.analysis)) return cached.exports
        importing.add(key)
        try {
            const analysis = this.analyzeModule(uriOfPath(path), -1, source, importing)
            const exports = this.exportsFrom(analysis, importing)
            this.modules.set(key, { analysis, exports })
            this.run?.analyzed.add(key)
            return exports
        } finally {
            importing.delete(key)
        }
    }

    /** Does every file `analysis` read — and everything the modules it
     *  imported read — still have the text it was analyzed against? */
    private isFresh(analysis: Analysis, seen = new Set<Analysis>()): boolean {
        if (seen.has(analysis)) return true
        seen.add(analysis)
        for (const [path, source] of analysis.dependencies) {
            if (this.readFile(path) !== source) return false
            const module = this.modules.get(pathKey(path))
            if (module && !this.isFresh(module.analysis, seen)) return false
        }
        return true
    }
}

/** The type aliases a set of libraries defines, resolved. */
function aliasesOf(libs: readonly Program[]): ReadonlyMap<string, Type> {
    const empty = parse("")
    return analyzeTypes(empty, analyzeScopes(empty, {}), { libs, diagnostics: false }).aliases
}

/** Where an option is written in a config, to point a problem at it. */
export function optionPosition(config: TiluaConfig, key: string): { line?: number; column?: number } {
    const offset = config.source.indexOf(JSON.stringify(key))
    if (offset < 0) return { line: 1, column: 1 }
    const before = config.source.slice(0, offset)
    return { line: before.split("\n").length, column: offset - before.lastIndexOf("\n") }
}
