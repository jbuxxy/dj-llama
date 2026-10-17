import pkg from '../package.json'

// The release tag's version (minus the v), a Docker build arg -- the nightly
// release tags without bumping package.json; a main build gets the latest
// release's. Empty (local build) falls back to package.json's.
export const VERSION = process.env.DJLLAMA_VERSION || pkg.version

// Docker build args become runtime ENV values for the backend container.
// On the web side, Vite `define` replaces these identifiers at build time.
export const GIT_SHA = process.env.DJLLAMA_GIT_SHA ?? 'dev'
export const CHANNEL = process.env.DJLLAMA_CHANNEL ?? 'local'
