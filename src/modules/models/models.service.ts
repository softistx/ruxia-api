import { NotFoundError } from "@softistx/mongo";
import type { AppMongo } from "../../config/db";
import { disabled, notFound, offline } from "./models.errors";
import type { ModelDocument } from "./models.model";
import type { StatusStore } from "./models.status";
import { inCatalogueOrder, isAvailable, viewOf } from "./models.utils";

// The model catalogue, for one request: the resolver ran the guard first
// (member to list, admin to list the disabled and to enable). Availability is
// read from the status the probe cached, never probed here.
export class ModelsService {
  constructor(
    private readonly mongo: Pick<AppMongo, "db">,
    private readonly statuses: StatusStore,
  ) {}

  // The last probe's answer; a store that fails reads as "no answer", so the
  // Ollama models are unavailable rather than the query failing.
  private async status() {
    try {
      return await this.statuses.get();
    } catch {
      return undefined;
    }
  }

  async list(options: { includeDisabled: boolean }) {
    const [found, status] = await Promise.all([
      this.mongo.db.models.findMany(
        options.includeDisabled ? {} : { filter: { enabled: true } },
      ),
      this.status(),
    ]);
    return found.sort(inCatalogueOrder).map((model) => viewOf(model, status));
  }

  // Enables or disables a model; one already in that state is left as it is.
  async setEnabled(id: string, enabled: boolean) {
    const models = this.mongo.db.models;
    const model = await models.findById(id);
    if (!model) throw notFound();
    try {
      const saved =
        model.enabled === enabled
          ? model
          : await models.update(id, { enabled });
      return viewOf(saved, await this.status());
    } catch (error) {
      if (error instanceof NotFoundError) throw notFound();
      throw error;
    }
  }

  // What a send to `id` calls before it reaches the provider: the model, or
  // `not-found`, `disabled` (an admin has not enabled it) and `offline` (an
  // Ollama server that is off or does not have it).
  async requireAvailable(id: string): Promise<ModelDocument> {
    const model = await this.mongo.db.models.findById(id);
    if (!model) throw notFound();
    if (!model.enabled) throw disabled(model);
    if (!isAvailable(model, await this.status())) throw offline(model);
    return model;
  }
}
