import { core } from 'ext:core/mod.js';
throw new Error(`Privileged static import unexpectedly succeeded: ${typeof core.ops}`);
