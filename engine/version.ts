/**
 * The engine's version, in its own module so that modules recording it into
 * state can import it without cycling through the package entry point.
 *
 * It is part of serialized session state: a recorded fixture says which engine
 * produced it, so a replay mismatch after an engine change reads as a version
 * difference rather than a mystery.
 */
export const ENGINE_VERSION = "0.0.0";
