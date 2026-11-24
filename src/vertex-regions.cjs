/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const VERTEX_MULTI_REGIONS = Object.freeze(['us', 'eu']);
const MULTI_REGION_SET = new Set(VERTEX_MULTI_REGIONS);

function isVertexMultiRegion(region) {
    return typeof region === 'string' && MULTI_REGION_SET.has(region);
}

function vertexApiHost(region) {
    if (region === 'global') return 'aiplatform.googleapis.com';
    if (isVertexMultiRegion(region)) return `aiplatform.${region}.rep.googleapis.com`;
    return `${region}-aiplatform.googleapis.com`;
}

module.exports = {
    VERTEX_MULTI_REGIONS,
    isVertexMultiRegion,
    vertexApiHost,
};
