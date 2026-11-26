import { clientHeader } from "../src/http/csrf";
import type { AuthApp } from "./auth";

// A GET of a run's events through the app, as `token`'s account (anonymous
// without one), with the client header unless `client` is false.
export function streamRun(
  kit: Pick<AuthApp, "app">,
  runId: string,
  options: {
    token?: string;
    client?: boolean;
    lastEventId?: string;
    signal?: AbortSignal;
  } = {},
) {
  const { token, client = true, lastEventId, signal } = options;
  return Promise.resolve(
    kit.app.fetch(
      new Request(`https://api.ruxia.test/runs/${runId}/events`, {
        headers: {
          ...(client && { [clientHeader]: "spec" }),
          ...(token && { authorization: `Bearer ${token}` }),
          ...(lastEventId !== undefined && { "last-event-id": lastEventId }),
        },
        ...(signal && { signal }),
      }),
    ),
  );
}

export interface Frame {
  id: string | undefined;
  event: string | undefined;
  data: { type: string; text?: string; reason?: string } | undefined;
}

// The frames of an event stream's text: each block of `id:`, `event:` and
// `data:` lines, and the comment lines (`: heartbeat`) apart.
export function framesOf(text: string) {
  const frames: Frame[] = [];
  const comments: string[] = [];
  for (const block of text.split("\n\n").filter(Boolean)) {
    const lines = block.split("\n");
    for (const line of lines) {
      if (line.startsWith(":")) comments.push(line.slice(1).trim());
    }
    const field = (name: string) =>
      lines
        .find((line) => line.startsWith(`${name}: `))
        ?.slice(name.length + 2);
    const data = field("data");
    if (data === undefined && field("event") === undefined) continue;
    frames.push({
      id: field("id"),
      event: field("event"),
      data: data === undefined ? undefined : JSON.parse(data),
    });
  }
  return { frames, comments };
}
