/**
 * HTTP service command-map bridge.
 *
 * Summary:
 * Temporary bridge used while the HTTP server service is being split. The stable
 * command-map module lives at src/command-map.ts; this file only adapts the
 * current service-local import path used by the legacy HTTP server module.
 *
 * Exports:
 * - buildHeadlessCommandRoutes(): HeadlessCommandRoute[]
 * - findHeadlessCommandRoute(pathname: string): HeadlessCommandRoute | null
 */
export { buildHeadlessCommandRoutes, findHeadlessCommandRoute } from "../command-map";
export type { HeadlessCommandRoute } from "../command-map";
