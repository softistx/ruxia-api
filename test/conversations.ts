import type { ModelAdapter } from "@softistx/ai-core";
import { fakeModel, type Script } from "@softistx/ai-testing";
import type { ModelAdapters } from "../src/modules/conversations";

// Adapters for specs: every model answers with the same scripted fake (an
// empty script by default, which fails any call), so no provider is reached.
export function fakeAdapters(script: Script = []): ModelAdapters & {
  models: ModelAdapter[];
} {
  const models: ModelAdapter[] = [];
  return {
    models,
    adapterFor: () => {
      const model = fakeModel(script);
      models.push(model);
      return model;
    },
  };
}

import { appMongo } from "../src/config/db";
import {
  ConversationsService,
  MessagesService,
} from "../src/modules/conversations";
import { ModelsService, noStatuses } from "../src/modules/models";
import { AvatarsService, PersonasService } from "../src/modules/personas";
// A member's conversation services for specs, over a real account: the
// conversations, messages and personas services of one viewer.
import { type authApp, signedInAccount } from "./auth";
import { sessionViewer } from "./execute";

export const sonnet = "claude-sonnet-5-5";

export async function memberOf(
  kit: ReturnType<typeof authApp>,
  options: { role?: "admin" | "member"; name?: string; now?: () => Date } = {},
) {
  const account = await signedInAccount(kit, options);
  const viewer = await sessionViewer(kit, account.token);
  const models = new ModelsService(appMongo, noStatuses, () => {});
  const personas = new PersonasService(
    appMongo,
    models,
    new AvatarsService(appMongo),
    viewer,
    async (id) => ({ id, name: options.name ?? "Ada" }),
  );
  const now = options.now ?? (() => new Date());
  return {
    id: account.userId,
    token: account.token,
    personas,
    conversations: new ConversationsService(
      appMongo,
      models,
      personas,
      viewer,
      now,
    ),
    messages: new MessagesService(appMongo, viewer, now),
  };
}
