import { serverAdapters } from "../modules/conversations/conversations.adapters";
import { env } from "./env";

// The adapters the server runs: `ANTHROPIC_API_KEY` and `OLLAMA_BASE_URL`.
export const serverModels = serverAdapters({
  anthropicKey: env.ANTHROPIC_API_KEY,
  ollamaBaseUrl: env.OLLAMA_BASE_URL,
});
