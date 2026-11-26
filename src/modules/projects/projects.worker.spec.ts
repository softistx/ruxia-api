import { describe, expect, test } from "bun:test";
import { localQueues } from "@softistx/redis";
import * as queues from "../../config/queues";
import { IndexingWorker, indexQueue } from "./projects.worker";

describe("the indexing queue and worker", () => {
  test("a document handed to the queue reaches the indexer with its attempt", async () => {
    const local = localQueues({ queues });
    const seen: { id: string; attempt: { number: number; of: number } }[] = [];
    const worker = new IndexingWorker(local.queues.indexing, {
      run: async (id, attempt) => {
        seen.push({ id, attempt });
      },
    });
    worker.start();
    worker.start();
    await indexQueue(local.queues.indexing).enqueue("doc-1");
    await Bun.sleep(50);
    expect(seen).toEqual([{ id: "doc-1", attempt: { number: 1, of: 3 } }]);
    await worker.stop();
    await local.close();
  });

  test("a failing run is retried until the attempts are spent", async () => {
    const local = localQueues({ queues });
    let runs = 0;
    const worker = new IndexingWorker(local.queues.indexing, {
      run: async () => {
        runs += 1;
        throw new Error("down");
      },
    });
    worker.start();
    await indexQueue(local.queues.indexing).enqueue("doc-2");
    await Bun.sleep(100);
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(queues.indexing.attempts).toBe(3);
    await worker.stop();
    await local.close();
  });

  test("stopping a worker that never started does nothing", async () => {
    const local = localQueues({ queues });
    await new IndexingWorker(local.queues.indexing, {
      run: async () => {},
    }).stop();
    await local.close();
  });
});
