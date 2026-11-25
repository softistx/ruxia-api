import { definePlugin } from "@softistx/graxia";

// A graxia plugin (src/app.ts): every GraphQL response carries
// `Cache-Control: no-store`. The answers hold a session token, a second-factor
// secret, and recovery codes; janus's guide asks that the secret
// and the codes are never cached by a browser or a proxy.
// Refusals carry it too (the client header's 403, graxia's 4xx). It sits first
// in the list: `respond` skips the plugins after the one that answers, so a
// plugin placed before the refusing ones still sets its header.
export const noStore = definePlugin({
  name: "ruxia-no-store",
  onRequest: ({ responseHeaders }) => {
    responseHeaders.set("cache-control", "no-store");
  },
});
