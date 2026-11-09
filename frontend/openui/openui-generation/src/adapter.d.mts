export interface PreparedArtifactHandle {
  /** Immutable host-prepared artifact content identity; not a file path. */
  readonly id: string;
  readonly rendererHash: string;
}
export interface GenerationContext {
  /** Host-owned session/branch identity, never chosen by generated code. */
  readonly scope: string;
  readonly snapshots: ReadonlyMap<string, PreparedArtifactHandle>;
}
interface SelectionBase<Adapter extends string> {
  readonly schema: 'native-visual-selection/v1';
  readonly status: 'validated-not-verified';
  readonly scope: string;
  readonly id: string;
  readonly sourceHash: string;
  readonly libraryHash: string;
  readonly generator: {
    readonly core: '@openuidev/lang-core@0.3.1';
    readonly adapter: Adapter;
  };
  readonly snapshot: { readonly key: string; readonly id: string; readonly rendererHash: string };
}
export interface RepositorySelection extends SelectionBase<'bounded-repository-selection/v1'> {
  readonly view: {
    readonly kind: 'repo-explorer';
    readonly mode: 'code' | 'churn';
    readonly metrics: readonly ('files' | 'code' | 'churn')[];
    readonly hottestLimit: number;
    readonly visibleLimit: 128;
  };
}
export type IntentSection =
  | { readonly kind: 'DeclaredIntent' | 'ContractGates' | 'WorkSlices' | 'ProofReceipts' | 'TokenValue' | 'ContextFlow' | 'RuntimeHealth' }
  | { readonly kind: 'DecisionMix'; readonly by: 'execution' | 'providers' | 'status' };
export interface IntentSelection extends SelectionBase<'bounded-intent-selection/v1'> {
  readonly view: { readonly kind: 'intent-board'; readonly sections: readonly IntentSection[] };
}
export type VisualSelection = RepositorySelection | IntentSelection;
export interface GenerationAdapter<S extends VisualSelection = VisualSelection> {
  readonly prompt: string;
  /** Call only once the host knows the model's program is complete. Not visual approval. */
  compile(source: string, context: GenerationContext): S;
}
export function createGenerationAdapter(): Promise<GenerationAdapter<RepositorySelection>>;
export function createGenerationAdapter(options: { library: 'repository' }): Promise<GenerationAdapter<RepositorySelection>>;
export function createGenerationAdapter(options: { library: 'intent' }): Promise<GenerationAdapter<IntentSelection>>;
