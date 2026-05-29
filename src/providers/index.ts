// Host-side provider container-config barrel.
// Providers that need host-side container setup (extra mounts, env passthrough,
// per-session directories) self-register on import.
//
// Skills add a new provider by appending one import line below.

// claude: contributes optional Langfuse OTEL env (and custom-endpoint env) to
// the container. Imported unconditionally so observability works on every
// install; both paths are dormant until their .env keys are set.
import './claude.js';
