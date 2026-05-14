/**
 * @import { NormalizerDispatcher } from '../normalizer_dispatcher.js'
 */

import { claudeNormalize } from './claude.js'

/**
 * Wire production normalizers onto a dispatcher. Bead 2 ships `claude`;
 * bead 4 will add `codex`. The unknown-provider passthrough is left to the
 * dispatcher's own default — bead 3 replaces it with a `raw_frame`-only row.
 *
 * Exposed as a function (rather than registered at module load) so test
 * doubles can build a dispatcher with hand-rolled stubs and bypass real
 * registration.
 *
 * @param {NormalizerDispatcher} dispatcher
 * @returns {void}
 */
export function registerProductionNormalizers(dispatcher) {
  dispatcher.register('claude', claudeNormalize)
}

export { claudeNormalize } from './claude.js'
