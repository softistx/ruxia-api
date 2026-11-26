import type { Handler, Worker, WorkOptions } from "@softistx/redis";
import type { indexing } from "../../config/queues";
import type { DocumentIndexer } from "./projects.indexing";

// The queue the worker takes jobs from: the `indexing` queue's `work`, bound by
// @softistx/redis over Redis or in this process.
export interface IndexingJobs {
  work(
    handler: Handler<(typeof indexing)["schema"]>,
    options?: WorkOptions,
  ): Worker;
}

// The background worker of the indexing: one job at a time (the embeddings
// server is small). Started from src/server.ts only, never by a request or a
// spec (specs call the indexer's `run` themselves).
export class IndexingWorker {
  private worker: Worker | undefined;

  constructor(
    private readonly jobs: IndexingJobs,
    private readonly indexer: Pick<DocumentIndexer, "run">,
  ) {}

  start() {
    if (this.worker) return;
    this.worker = this.jobs.work(
      (job) =>
        this.indexer.run(
          job.data.documentId,
          { number: job.attempt, of: job.attempts },
          job.signal,
        ),
      { concurrency: 1 },
    );
  }

  // Stops taking jobs and waits for the one running.
  async stop() {
    const worker = this.worker;
    this.worker = undefined;
    await worker?.close({ grace: "10s" });
  }
}

// The queue as the services enqueue on it: one job per document.
export const indexQueue = (jobs: {
  add(data: { documentId: string }): Promise<unknown>;
}) => ({
  enqueue: async (documentId: string) => {
    await jobs.add({ documentId });
  },
});
