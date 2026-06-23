/**
 * HTTP/SSE server service entry.
 *
 * Summary:
 * Public server entrypoint for starting the local HTTP/SSE runtime host. This
 * file now exposes a stable entry surface while the legacy implementation is
 * progressively split into focused services.
 *
 * Exports:
 * - runHeadlessHttp(options: HeadlessOptions): Promise<void>
 * - type HeadlessOptions
 */
export { runHeadlessHttp } from "./legacy-http-server";
export type { HeadlessOptions } from "./legacy-http-server";
