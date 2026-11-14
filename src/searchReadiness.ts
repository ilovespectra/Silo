export interface SearchReadinessPipeline {
  savedRecordsReady: Promise<unknown>;
  modelReady: Promise<unknown>;
  storageAvailable: boolean;
  onWaitingForModel: () => void;
  onPreparingVectorSearch: () => void;
  prepareVectorSearch: () => Promise<unknown>;
}

/** Resolve readiness only after records, the local model, and the fast index are ready. */
export async function prepareSearchReadiness(
  pipeline: SearchReadinessPipeline,
): Promise<void> {
  await pipeline.savedRecordsReady;
  if (!pipeline.storageAvailable) return;

  pipeline.onWaitingForModel();
  await pipeline.modelReady;
  pipeline.onPreparingVectorSearch();
  await pipeline.prepareVectorSearch();
}
