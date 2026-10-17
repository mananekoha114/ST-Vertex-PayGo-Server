/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Bundling entry for scripts/build-vendor.mjs.
//
// The plugin keeps zero runtime package dependencies: users never run npm.
// isomorphic-git and its HTTP client are bundled into one committed file that
// the updater loads lazily, so an installation without an update never pays
// for it.

export * as git from 'isomorphic-git';
export * as http from 'isomorphic-git/http/node';
