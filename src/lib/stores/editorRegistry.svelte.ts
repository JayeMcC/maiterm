import type { EditorView } from '@codemirror/view';
import { SvelteSet } from 'svelte/reactivity';

export interface EditorRegistryEntry {
  view: EditorView;
  filePath: string;
  isDirty: boolean;
}

// Simple mutable map - not reactive (accessed by reference)
// eslint-disable-next-line svelte/prefer-svelte-reactivity -- imperative lookup registry; entries are read via getEditorByTabId/getEditorByFilePath, never in reactive templates
const registry = new Map<string, EditorRegistryEntry>();

// Reactive set of dirty tab IDs read via `isEditorDirty()` in tab-list templates.
const dirtyTabs = new SvelteSet<string>();

export function registerEditor(tabId: string, view: EditorView, filePath: string): void {
  registry.set(tabId, { view, filePath, isDirty: false });
}

export function unregisterEditor(tabId: string): void {
  registry.delete(tabId);
  dirtyTabs.delete(tabId);
}

export function setEditorDirty(tabId: string, dirty: boolean): void {
  const entry = registry.get(tabId);
  if (entry) entry.isDirty = dirty;
  if (dirty) dirtyTabs.add(tabId);
  else dirtyTabs.delete(tabId);
}

export function isEditorDirty(tabId: string): boolean {
  return dirtyTabs.has(tabId);
}

export function getEditorByTabId(tabId: string): EditorRegistryEntry | undefined {
  return registry.get(tabId);
}

export function getEditorByFilePath(filePath: string): { tabId: string; entry: EditorRegistryEntry } | undefined {
  for (const [tabId, entry] of registry) {
    if (entry.filePath === filePath) return { tabId, entry };
  }
  return undefined;
}

/** Diagnostic snapshot for getDiagnostics. */
export function getEditorRegistrySizes() {
  return {
    registered: registry.size,
    dirty_tabs: dirtyTabs.size,
  };
}
