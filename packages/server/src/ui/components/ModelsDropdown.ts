/**
 * Legacy model option compatibility shim.
 *
 * Summary:
 * Keeps the current monolithic HTTP module compiling while model options are
 * moved out of the old UI-shaped path. Remove this file when src/headless/http.ts
 * is split and updated to import from src/model-options directly.
 *
 * Exports:
 * - MODEL_COMMAND_MODELS
 * - MODEL_COMMAND_THINKING_OPTIONS
 */
export { MODEL_COMMAND_MODELS, MODEL_COMMAND_THINKING_OPTIONS } from "../../model-options";
