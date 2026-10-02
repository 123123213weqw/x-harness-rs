/** Narrow Cordis surface used by the bootstrap enrollment plugin. */
export interface ModuleContext {
  reflect: { provide(name: 'modules', value: import('./system').ClientModuleSystem): void }
}
