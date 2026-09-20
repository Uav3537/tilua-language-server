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
 * reused while every file it read — its config, type libraries and sourcemap —
 * still has the text it was analyzed against, and every module it imports
 * still exports what it did.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
    parse, parseWithRecovery, analyzeScopes, analyzeTypes, moduleExports, getBinding,
    findConfig, resolveTypeLibraries, moduleCandidates, sourceMapTypes,
    type Program, type ScopeAnalysis, type TypeAnalysis, type ParseError, type ModuleExports,
    type Binding, type Identifier, type Type, type TiluaConfig, type ConfigProblem, type ProjectHost,
    type SourceMapTypes, type Directives, type GenericRefType,
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
    /** Every file this analysis read other than a module — its config, type
     *  libraries, sourcemap — with the text it read, or `undefined` for a file
     *  it looked for and did not find (a module included). How a cached result
     *  tells that something changed, appeared or vanished under it. */
    readonly dependencies: ReadonlyMap<string, string | undefined>
    /** Each module it imports, by path, with the exports it read from it. A
     *  module's text can change without its exports changing — an edit inside
     *  a function body — and then this analysis is still good. */
    readonly imports: ReadonlyMap<string, ModuleExports>
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

/** The classes a set of definitions declares. */
function classesOf(libs: readonly Program[]): Set<string> {
    const names = new Set<string>()
    for (const lib of libs) {
        for (const statement of lib.body.statements) {
            if (statement.type === "DeclareClassStatement") names.add(statement.name.name)
        }
    }
    return names
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

// Both conversions below are asked for the same few hundred strings over and
// over — once per dependency per freshness check — and neither is cheap:
// `fileURLToPath` and `resolve` together were a third of a keystroke's time.
// The answers never change, so each string is converted once.
const pathsOfUris = new Map<string, string | undefined>()
const pathKeys = new Map<string, string>()

/** A file URI's path, or `undefined` for anything that is not a file. */
export function pathOfUri(uri: string): string | undefined {
    if (pathsOfUris.has(uri)) return pathsOfUris.get(uri)
    let path: string | undefined
    if (uri.startsWith("file:")) {
        try {
            path = fileURLToPath(uri)
        } catch {
            path = undefined
        }
    }
    pathsOfUris.set(uri, path)
    return path
}

export function uriOfPath(path: string): string {
    return pathToFileURL(path).href
}

/** Paths compare case-insensitively on Windows, where editors and the file
 *  system disagree about drive-letter case. */
export function samePath(a: string, b: string): boolean {
    return pathKey(a) === pathKey(b)
}

/** A path in the one spelling two names of the same file share. */
export function pathKey(path: string): string {
    let key = pathKeys.get(path)
    if (key === undefined) {
        const normalized = resolve(path)
        key = process.platform === "win32" ? normalized.toLowerCase() : normalized
        pathKeys.set(path, key)
    }
    return key
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
    /** Modules the first pass analyzed that the second has not redone yet.
     *  Their first-pass entries stay cached until then, for the second pass
     *  to compare its exports with. */
    readonly redo: Set<string>
}

// --------------------------------------------------------------------------
// Analyzer
// --------------------------------------------------------------------------

interface Module {
    analysis: Analysis
    exports: ModuleExports
    /** What `exports` says, in a form two analyses can be compared by — see
     *  `exportsFingerprint`. `undefined` when it cannot be compared. */
    fingerprint: string | undefined
}

/** Everything a folder's files are analyzed with. */
interface Context {
    readonly project: Project
    /** The type libraries, then the sourcemap's tree. */
    readonly libs: readonly Program[]
    readonly globals: readonly string[]
    readonly sourceMap?: SourceMapTypes
    /** The classes the libraries declare. */
    readonly libraryClasses: ReadonlySet<string>
    /** Every file read to build this, with what it held. */
    readonly reads: ReadonlyMap<string, string | undefined>
    /** Every folder listed to build this — a `"@tilua-types/*"` in `types` —
     *  with the names it held, so installing a library is noticed. */
    readonly listings: ReadonlyMap<string, string | undefined>
}

const NO_PROJECT: Context = {
    project: { fixed: false, problems: [] }, libs: [], globals: [], libraryClasses: new Set(), reads: new Map(),
    listings: new Map(),
}

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
                libraryClasses: classesOf(options.libs),
                reads: new Map(),
                listings: new Map(),
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
        const analysis = this.asModule(document, source) ?? this.analyze(document.uri, document.version, source)
        this.cache.set(document.uri, analysis)
        return analysis
    }

    /** The analysis another file's import already made of this text, as the
     *  document's own — so a module opened after something imported it, or
     *  imported after it was opened, is analyzed once rather than once each
     *  way. `undefined` when there is none, or it is out of date. */
    private asModule(document: TextDocument, source: string): Analysis | undefined {
        const path = pathOfUri(document.uri)
        const module = path ? this.modules.get(pathKey(path)) : undefined
        if (!module || module.analysis.source !== source || !this.isFresh(module.analysis)) return undefined
        // The URI the editor spells the file with, which is what every answer
        // about the document is sent back with.
        return { ...module.analysis, uri: document.uri, version: document.version }
    }

    /** The document analysis `get` made of `path`'s text, if it is still good. */
    private asDocument(path: string, source: string): Analysis | undefined {
        const open = this.openDocument?.(path)
        const analysis = open ? this.cache.get(open.uri) : undefined
        if (!analysis || analysis.source !== source || !this.isFresh(analysis)) return undefined
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

    /** What the module at `path` exports, to list the names it offers: the
     *  last analysis for as long as the file's own text is the same, even when
     *  something it imports has changed since.
     *
     *  Completion lists every module's exports on every keystroke, and the
     *  file being typed in is imported by some of them — checking them in
     *  full would re-analyze each of those, each time, to list names the edit
     *  cannot have changed. The sweep that follows the typing catches them up. */
    listedExportsAt(path: string): ModuleExports | undefined {
        const cached = this.modules.get(pathKey(path))
        if (cached && cached.analysis.source === this.readFile(path)) return cached.exports
        return this.exportsAt(path)
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

    /** Whether each analysis was found fresh during the sweep going on now. */
    private freshThisSweep?: Map<Analysis, boolean>

    /** What each folder held during the sweep going on now. */
    private listingsThisSweep?: Map<string, string[] | undefined>

    /** Runs one sweep over the open files — or one request about one of them
     *  — during which each path is `stat`ed at most once and each analysis is
     *  checked for freshness at most once.
     *
     *  Re-checking every open file asks about the same handful of type
     *  libraries and modules once per file — thousands of `stat` calls over a
     *  project of any size — and completion asks for every module of the
     *  project to list what could be imported. A sweep is synchronous, so
     *  nothing on disk or in the editor can move in the middle of one and the
     *  first answer stands for the rest of it. Outside a sweep every path is
     *  read afresh, so a file written and then asked about is seen. */
    sweep<T>(run: () => T): T {
        // A nested call belongs to the sweep already running.
        if (this.stampsThisSweep) return run()
        this.stampsThisSweep = new Map()
        this.freshThisSweep = new Map()
        this.listingsThisSweep = new Map()
        try {
            return run()
        } finally {
            this.stampsThisSweep = undefined
            this.freshThisSweep = undefined
            this.listingsThisSweep = undefined
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
        if (cached && this.unchanged(cached.reads) && this.sameListings(cached.listings)) return cached
        const context = this.buildContext(path)
        this.contexts.set(key, context)
        return context
    }

    private buildContext(path: string): Context {
        const reads = new Map<string, string | undefined>()
        const listings = new Map<string, string | undefined>()
        const host: ProjectHost = {
            readFile: file => {
                const text = this.readFile(file)
                reads.set(file, text)
                return text
            },
            readDirectory: directory => {
                const names = this.listDirectory(directory)
                listings.set(directory, names?.join("\n"))
                return names
            },
        }

        const lookup = findConfig(path, host)
        const problems: ConfigProblem[] = [...lookup.problems]
        const config = lookup.config
        if (!config) return { ...NO_PROJECT, project: { fixed: false, problems }, reads, listings }

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

        return {
            project: { config, fixed: false, problems },
            libs, globals: globalsOf(libs), libraryClasses: classesOf(libs), sourceMap, reads, listings,
        }
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

    /** Does every folder still hold the names it did? */
    private sameListings(listings: ReadonlyMap<string, string | undefined>): boolean {
        for (const [directory, names] of listings) if (this.listDirectory(directory)?.join("\n") !== names) return false
        return true
    }

    /** The folders in a folder, listed at most once a sweep, like `stamp`. */
    private listDirectory(directory: string): string[] | undefined {
        const known = this.listingsThisSweep?.get(directory)
        if (known !== undefined || this.listingsThisSweep?.has(directory)) return known
        let names: string[] | undefined
        try {
            names = readdirSync(directory, { withFileTypes: true })
                .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
                .map(entry => entry.name)
                .sort()
        } catch {
            names = undefined
        }
        this.listingsThisSweep?.set(directory, names)
        return names
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
        const run: Run = { cycles: new Set(), analyzed: new Set(), provisional: new Map(), redo: new Set() }
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
            for (const key of run.analyzed) run.redo.add(key)
            const second = analyzeRoot().result
            // What the second pass never came back to is still the first
            // pass's, `any` and all.
            for (const key of run.redo) this.modules.delete(key)
            return second
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
        const imports = new Map<string, ModuleExports>()
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
                if (exports) imports.set(target, exports)
                return exports
            },
        })
        return {
            uri, version, source, program, parseErrors: errors, directives, scopes, types,
            dependencies, imports, project: context.project,
        }
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
        if (cached && !this.run?.redo.has(key) && cached.analysis.source === source && this.isFresh(cached.analysis)) {
            return cached.exports
        }
        importing.add(key)
        try {
            const analysis = this.asDocument(path, source) ?? this.analyzeModule(uriOfPath(path), -1, source, importing)
            let exports = this.exportsFrom(analysis, importing)
            const fingerprint = exports.partial
                ? undefined
                : exportsFingerprint(exports, this.contextFor(path).libraryClasses)
            // The same exports as before, come to again: the modules that
            // read the old ones read exactly this, so they stay as they are.
            if (fingerprint !== undefined && cached?.fingerprint === fingerprint) exports = cached.exports
            this.modules.set(key, { analysis, exports, fingerprint })
            this.run?.redo.delete(key)
            this.run?.analyzed.add(key)
            return exports
        } finally {
            importing.delete(key)
        }
    }

    /** Does every file `analysis` read — and everything the modules it
     *  imported read — still have the text it was analyzed against? */
    private isFresh(analysis: Analysis): boolean {
        const known = this.freshThisSweep?.get(analysis)
        if (known !== undefined) return known
        const seen = new Set<Analysis>()
        const fresh = this.isFreshWalk(analysis, seen)
        // Every module the walk reached was checked in full, so a fresh root
        // vouches for all of them. A stale one says nothing about the modules
        // visited before it was found — only about itself.
        if (fresh) for (const visited of seen) this.freshThisSweep?.set(visited, true)
        else this.freshThisSweep?.set(analysis, false)
        return fresh
    }

    /** A module met again on the way is assumed fresh — it is being checked
     *  further up — which is why only the root's verdict is kept. */
    private isFreshWalk(analysis: Analysis, seen: Set<Analysis>): boolean {
        if (seen.has(analysis)) return true
        const known = this.freshThisSweep?.get(analysis)
        if (known !== undefined) return known
        seen.add(analysis)
        for (const [path, source] of analysis.dependencies) {
            if (this.readFile(path) !== source) return false
        }
        for (const [path, exports] of analysis.imports) {
            if (this.currentExports(path, seen) !== exports) return false
        }
        return true
    }

    /** What the module at `path` exports now, as far as a freshness check can
     *  tell. A module whose own text or imports changed is analyzed again —
     *  its exports may well have come out the same, and if so everything that
     *  imports it is still good. Inside an analysis run that is left to the
     *  run, which is analyzing whatever is out of date already; a changed
     *  module then reads as `undefined`, which no recorded export equals. */
    private currentExports(path: string, seen: Set<Analysis>): ModuleExports | undefined {
        const key = pathKey(path)
        const module = this.run?.redo.has(key) ? undefined : this.modules.get(key)
        if (module && module.analysis.source === this.readFile(path) && this.isFreshWalk(module.analysis, seen)) {
            return module.exports
        }
        return this.run ? undefined : this.exportsAt(path)
    }
}

/**
 * Everything a module's exports say, as a string: equal strings, equal
 * exports, as far as any module importing them could tell.
 *
 * Types are plain data, so this is a walk over the objects, with a number
 * standing in for one already written — types are recursive. What it leaves
 * out is only what cannot differ: a library class is written as its name,
 * since the libraries are the same for both analyses or the importing module
 * would be out of date anyway (and writing one out would write the engine);
 * a `private` member's owner is a node, told apart by identity alone. A ref
 * to an alias is written with what the alias resolves to in the module that
 * wrote it, which is where the alias's own changes show.
 *
 * Something too big to be worth comparing gives `undefined`.
 */
function exportsFingerprint(exports: ModuleExports, libraryClasses: ReadonlySet<string>): string | undefined {
    const LIMIT = 200_000
    const out: string[] = []
    const ids = new Map<object, number>()
    const expanding = new Set<string>()
    const idOf = (value: object): number => {
        let id = ids.get(value)
        if (id === undefined) ids.set(value, id = ids.size)
        return id
    }
    const write = (value: unknown): boolean => {
        if (out.length > LIMIT) return false
        if (value === null || typeof value !== "object") {
            out.push(typeof value === "function" ? "fn" : value === undefined ? "u" : JSON.stringify(value))
            return true
        }
        const seen = ids.get(value)
        if (seen !== undefined) {
            out.push(`#${seen}`)
            return true
        }
        idOf(value)
        if (value instanceof Map) {
            out.push("M{")
            for (const [key, entry] of value) {
                out.push(String(key), ":")
                if (!write(entry)) return false
            }
            out.push("}")
            return true
        }
        if (Array.isArray(value)) {
            out.push("[")
            for (const entry of value) if (!write(entry)) return false
            out.push("]")
            return true
        }
        const record = value as Record<string, unknown>
        if (record.kind === "object" && record.class) {
            const info = record.class as { name: string; typeArguments?: unknown }
            if (libraryClasses.has(info.name)) {
                out.push(`C:${info.name}`)
                return write(info.typeArguments)
            }
        }
        if (record.kind === "genericRef" && record.origin) {
            const ref = record as unknown as GenericRefType
            const key = `${idOf(ref.origin!)}:${ref.name}`
            out.push(`R:${ref.name}<`)
            if (!write(ref.typeArguments)) return false
            out.push(">")
            if (expanding.has(key)) return true
            expanding.add(key)
            try {
                return write(ref.origin!.expand(ref))
            } finally {
                expanding.delete(key)
            }
        }
        out.push("{")
        for (const key of Object.keys(record)) {
            if (key === "origin" || key === "owner") continue
            out.push(key, "=")
            if (!write(record[key])) return false
        }
        out.push("}")
        return true
    }
    const whole = { values: exports.values, types: exports.types, default: exports.default }
    return write(whole) ? out.join(" ") : undefined
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
