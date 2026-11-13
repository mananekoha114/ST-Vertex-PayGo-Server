/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

// Gemini 4 models served by the native generation route and the continuation
// transport. The prepare response advertises this list so a frontend can tell
// whether this server accepts a model before it retargets the request.
const GEMINI4_MODELS = Object.freeze(['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon', 'gemini-4-argon-cyber-permissive']);
const isGemini4Model = model => GEMINI4_MODELS.includes(model);

// Hydrogen adds XHIGH above HIGH; Carbon and Argon top out at HIGH.
const XHIGH_MODELS = new Set(['gemini-4-hydrogen']);
const maxThinkingLevel = model => XHIGH_MODELS.has(model) ? 'XHIGH' : 'HIGH';

// Vertex rejects a Hydrogen replay with HTTP 400 once an earlier turn or the
// system instruction differs from what a signature was issued for, unless
// ThinkingConfig asks it to drop mismatched signatures. AI Studio's
// ThinkingConfig has no such field, so it must not be sent there.
const PREFIX_DROP_MODELS = new Set(['gemini-4-hydrogen']);
const dropsMismatchedSignatures = (model, source) => source === 'vertexai' && PREFIX_DROP_MODELS.has(model);

module.exports = { GEMINI4_MODELS, isGemini4Model, maxThinkingLevel, dropsMismatchedSignatures };
