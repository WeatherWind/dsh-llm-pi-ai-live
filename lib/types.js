/**
 * Structural slices of the DSH host seams this plugin talks to.
 *
 * The plugin deliberately declares *shapes*, not imports: it is mounted into a
 * running harness whose packages are resolved by the profile, and a structural
 * contract keeps the build hermetic (no compile-time dependency on the host's
 * internal package graph) while still failing loudly at runtime when a seam is
 * missing. Every member below is a subset of a documented service method; none
 * is invented.
 *
 * @module dsh-llm-pi-ai-live/types
 */
export {};
//# sourceMappingURL=types.js.map