import { createRequire } from 'node:module';

// Koa's maintained CommonJS dependencies require native built-ins. Workers has no
// import.meta.url; this absolute virtual filename is used only by createRequire.
// This is the platform's native loader, not a package/filesystem loader polyfill.
globalThis.require = createRequire('/corner-worker.js');
