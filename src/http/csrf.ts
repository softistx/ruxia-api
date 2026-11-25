import { definePlugin } from "@softistx/graxia";
import { fail } from "../shared/errors";

// The header every /graphql request carries, any non-empty value (the
// client's name: "ruxia-ui", "apollo-sandbox"…). A browser sends a custom
// header only after a CORS preflight, which a page of another origin does not
// pass, and a form or a plain <img> GET cannot send one: no cross-site
// request reaches a resolver, cookie or not.
export const clientHeader = "x-ruxia-client";

// A graxia plugin (src/app.ts): an operation without the header is refused
// before it is run, 403 `auth.errors.client-header-required`. graxia's own CSRF
// check (on by default) covers the requests a browser does not preflight; this
// one checks every operation. It runs in `onParams`, so the IDE's page (a GET
// with no operation) still loads.
export const requireClientHeader = definePlugin({
  name: "ruxia-client-header",
  onParams: ({ request, respond }) => {
    if (request.headers.get(clientHeader)?.trim()) return;
    const error = fail("auth.errors.client-header-required", {
      params: { header: clientHeader },
      status: 403,
    });
    const { http: _http, ...extensions } = error.extensions;
    respond(
      Response.json(
        { errors: [{ message: error.message, extensions }] },
        { status: 403, headers: {} },
      ),
    );
  },
});
