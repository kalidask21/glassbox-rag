/** Picks the retrieval backend. Both expose the same functions and return the same row shape. */
import * as postgres from './retrieve.js';
import * as elastic from './retrieveElastic.js';

const BACKENDS = { postgres, elastic };
export const BACKEND_NAMES = Object.keys(BACKENDS);

export function getBackend(name) {
  const backend = BACKENDS[name];
  if (!backend) throw new Error(`Unknown search backend "${name}". Use one of: ${BACKEND_NAMES.join(', ')}`);
  return backend;
}
