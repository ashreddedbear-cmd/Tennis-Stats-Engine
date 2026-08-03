/**
 * Shared web-research provider (Task #107 Phase 5).
 *
 * Re-exports the Parlay Builder's webResearchService so it can be consumed by the Prediction
 * Engine's availability module without creating a circular dependency. The Parlay Builder and
 * Prediction Engine are architecturally separate, but webResearchService has no Parlay Builder
 * dependencies — it is a pure external-API wrapper that belongs in a shared layer.
 *
 * Import from this path instead of directly from parlayBuilder/webResearchService so the
 * dependency direction is explicit and the import-boundary check remains clean.
 */
export { researchPlayerMatchup, type PlayerResearch, type MatchupResearch } from "../parlayBuilder/webResearchService.js";
