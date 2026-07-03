# @forwood/task-engine

TypeScript interpreter of VS Code `.vscode/tasks.json`. Reads the JSONC, substitutes `${workspaceFolder}` / `${env:…}` / `${input:…}`, surfaces the `dependsOn` graph — and emits declarative task records for surface-specific [[dispatcher]]s (tmux send-keys, maiTerm `openTab`, future) to translate into actual execution.

Architecture: **ADR 0005 — Task engine and dispatcher architecture** (`docs/adr/0005-task-engine-and-dispatchers.md`).

## Why

Pre-ADR, the tmux task-picker and a hypothetical maiTerm launcher would each have to re-parse `tasks.json` and re-build the dispatch contract. The engine centralises that work behind one TypeScript surface, so every dispatcher reads the same shape and inherits future VS Code schema additions for free.

The engine **never** invents fields — it returns records whose shape matches `tasks.json` exactly. Dispatchers do the translation (e.g. `presentation.panel === 'dedicated' && presentation.group === 'API'` → "find or spawn maiTerm tab named `API`").

## Runtime

- **Node v22.6+ required** (native TS type-stripping; no build step, no `tsx`, no `dist/`).
- No transitive runtime deps beyond `jsonc-parser`.
- Importable as an ESM module from any consumer (`node` runtimes); also callable as a CLI for shell consumers (the legacy tmux picker).

## CLI

```sh
# List every task in a clone's tasks.json (omits `hide: true` by default).
task-engine list /path/to/forwood-one_developing

# Resolve a task — variable-substitute its fields and build its dependsOn tree.
task-engine resolve /path/to/forwood-one_developing "Spin up dev servers"

# Provide pre-resolved input values for ${input:id} references.
task-engine resolve /path/to/forwood-one_developing "Lint branch diff" \
  --input lintBranchTarget=release/1.8.0
```

Output is JSON. The engine itself never prompts — callers (CLI / Ink launcher) are responsible for collecting input values and passing them in.

## Execution context (PLAN-15 / ADR 0006)

Tasks run on the **host by default**; a task is container-context exactly when
the **container gate** task (`REQUIRE_DEVCONTAINER_LABEL`, default `Require
devcontainer`, overridable per call) appears in its transitive `dependsOn`
chain. The engine derives this at emission — every `TaskTreeNode` carries
`executionContext: 'host' | 'container'`; the source file gains no field.
Dispatchers wrap only container nodes with `devcontainer exec`; the maiTerm
dispatcher additionally accepts `containerPrelude` (typically the gate script)
so container tabs are cold-start self-sufficient.

Two related helpers:

- `deriveExecutionContext(label, tasks, { gateLabel? })` — one task's context
  without keeping the tree.
- `resolveDir(dir)` — marker walk-up mirroring the hotbar detectors:
  `.vscode/tasks.json` → `repoRoot`, `.devcontainer/devcontainer.json` probed
  independently; innermost owner wins.
- `resolveTask(clone, label, ctx, { workspaceFolderHost })` — host-context
  nodes resolve `${workspaceFolder}` against the host path, container nodes
  against `ctx.workspaceFolder` (the container-side path).

## Programmatic use

```ts
import {
  listTasks,
  resolveTask,
  type VariableContext,
} from '@forwood/task-engine';

const ctx: VariableContext = {
  workspaceFolder: '/path/to/forwood-one_developing',
  env: process.env,
  inputs: { lintBranchTarget: 'release/1.8.0' },
};

const tasks = listTasks(ctx.workspaceFolder);
const tree = resolveTask(ctx.workspaceFolder, 'Spin up dev servers', ctx);
// `tree` is a TaskTreeNode — task, dependsOn[], dependsOrder.
```

## What's NOT in the engine

- **Execution.** Dispatchers run things; the engine emits structure.
- **Input prompting.** Callers collect `${input:id}` values via their own UI.
- **Editor-context variables** (`${file}`, `${selectedText}`, `${lineNumber}`, …). The engine has no editor context; these references are left as literal `${file}` in output.
- **`problemMatcher` evaluation.** The field is preserved on the record but the engine doesn't run matchers.

## Tests

```sh
pnpm test          # vitest run
pnpm test:watch    # vitest
pnpm typecheck     # tsc --noEmit
```

Fixtures under `src/__tests__/fixtures/<scenario>/.vscode/tasks.json` mirror the shapes we actually see in `forwood-one`'s tasks.json: basic dedicated panels, composite `dependsOn` chains, `${input:…}` references, and a deliberate cycle (for the cycle-detection test).
