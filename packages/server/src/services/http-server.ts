/**
 * HTTP/SSE server service entry.
 *
 * Summary:
 * Re-exports the current server entrypoint while the legacy monolithic HTTP
 * module is split into smaller services. New imports should prefer this module
 * rather than importing from src/headless/http directly.
 *
 * Exports:
 * - runHeadlessHttp(options: HeadlessOptions): Promise<void>
 * - type HeadlessOptions
 */
export { runHeadlessHttp } from "../headless/http";
export type { HeadlessOptions } from "../headless/http";
