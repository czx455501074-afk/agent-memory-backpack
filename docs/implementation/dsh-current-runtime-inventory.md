# DSH desktop 0.2.0-rc.2 runtime inventory

## Runtime and package locations

The installed desktop resource root is `<USER_HOME>/AppData/Local/Programs/DeepSeek Harness/resources`. `resources/runtime/` contains the bundled `pnpm` runtime, not the DSH application packages. The JavaScript application package tree is under `resources/app.asar/dsh/`; `resources/app.asar.unpacked/dsh/node_modules/` is the unpacked dependency area and does not contain the five target packages. The actual shipped package paths below are ASAR virtual paths, resolved by the Electron/Node runtime with ASAR support.

`resources/app.asar/dsh/package.json` identifies `@deepseek-ai/dsh-desktop-runtime` `0.2.0-rc.2`. Its CLI package is `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json`, version `0.2.0-rc.2`, with `bin.dsh = lib/bin.js` and exported `./profile-boot`. Thus the bundled DSH CLI entry is `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js`.

The user runtime manifest `<USER_HOME>/.dsh/dsh-runtimes/dsh-primary-runtime/runtime.json` reports desktop version `0.2.0-rc.2`, `win32/x64`, and Node `24.21.0`. It also has a `dependencies/node` runtime tree; the five DSH application packages are supplied by the desktop ASAR package tree above, not that runtime's `node_modules`.

| Package | Version | Shipped entry path | Package export |
|---|---:|---|---|
| `@deepseek-ai/cordis` | `4.0.4` | `resources/app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js` | `.` → `./lib/index.js` |
| `@deepseek-ai/dsh-tools` | `0.2.0-rc.2` | `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js` | `.` → `./lib/index.js`; also `./types`, `./presentation`, `./invariant` |
| `@deepseek-ai/dsh-system-prompt` | `0.2.0-rc.2` | `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js` | `.` → `./lib/index.js`; also `./invariant` |
| `@deepseek-ai/dsh-agent` | `0.2.0-rc.2` | `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js` | `.` → `./lib/index.js`; also `./types`, `./invariant` |
| `@deepseek-ai/dsh-app-boot` | `0.2.0-rc.2` | `resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js` | `.` → `./lib/index.js`; also `./worker/profile-resolution-bootstrap` |

For standalone Node inspection, the desktop's `dsh/` ASAR subtree was copied by the root task to `<PROJECT_ROOT>/.local/dsh-runtime-0.2.0-rc.2/`. `createRequire()` from that copy resolved all five package specifiers to their `node_modules/@deepseek-ai/<package>/lib/index.js` files. This verifies Node package resolution on the extracted copy; it does not claim plain Node can resolve Electron's ASAR virtual paths without Electron's ASAR integration.

## Compatibility surface used by this adapter

The current package source declares Cordis event registration as:

```ts
on<K extends keyof Events>(name: K, listener: Events[K], options?: boolean | EventOptions): () => boolean
```

`Context.effect` has synchronous and asynchronous overloads:

```ts
effect(execute: () => SyncEffect, label?: string): Disposable<Promise<void>>
effect(execute: () => Effect, label?: string): AsyncDisposable<Promise<void>>
```

The DSH adapter uses `ctx.on('agent/pre-step', async (payload, next) => ...)`, `ctx.on('tools/pre-execute', async (exec, next) => ...)`, and `ctx.on('session/event', (session, event) => ...)`; `agent/pre-step` and `tools/pre-execute` are waterfalls, so listeners receive the event payload and `next`, and return the resulting decision. It registers tools with `ctx.tools.register(definition)` and a final synchronous `ctx.tools.guard(exec => string | undefined)`. In `dsh-tools` 0.2.0-rc.2, `register` returns the exact disposer and validates `output.schema` plus `output.render`; `guard` returns a disposer and runs after the extensible `tools/pre-execute` waterfall. A returned reason string denies execution; guards are monotonic and cannot override another denial.

Evidence files in the extracted current runtime: `node_modules/@deepseek-ai/cordis/src/events.ts` (event signature), `cordis/src/fiber.ts` (`effect` overloads), and `dsh-tools/lib/types/index.js` (runtime `register`/`guard` behavior and ordering). The desktop production copy exposes package manifests that point at `.d.ts` paths, but the shipped ASAR subtree inspected here does not contain those declarations; the signatures above therefore come from its bundled Cordis source and runtime implementation/JSDoc, not an installed TypeScript compile check.

## Comparison with the old 0.1.7-rc.1 profile baseline

`<DSH_HOME>/data/profiles/node_modules/@deepseek-ai` is the older environment, not the current desktop runtime. Its `dsh-tools`, `dsh-system-prompt`, `dsh-agent`, `dsh-app-boot`, and `dsh` packages are `0.1.7-rc.1`; Cordis is `4.0.4`. Package entry and export maps for the five packages are the same in the old profile and current desktop runtime. Cordis `src/events.ts` has the same SHA-256 in both inspected trees. The `dsh-tools` `register(definition)` and `guard(guard)` implementations also match byte-for-byte in the two versions. The application packages themselves are different version cohorts; do not infer full runtime compatibility from matching method surfaces.

The local adapter's compatibility decision is versioned against the current `0.2.0-rc.2` peer. The root task reports that its real compatibility evaluator accepts the P0.2 package and rejects the `0.1.7-rc.1` peer, and that the real desktop runtime test and DSH test suite passed. Those are coordinator-reported integration results, distinct from this read-only package/API inspection.

## Evidence limits

No credentials, session bodies, or real profile contents were read. The real profile `<USER_HOME>/.dsh/profiles/desktop` was not changed. This inventory does not claim an independent plugin install or runtime invocation; the root task reports those separately. The source export maps and package versions establish the shipped entry paths, while the extracted-copy `createRequire()` check establishes ordinary Node resolution only for that isolated copy.
