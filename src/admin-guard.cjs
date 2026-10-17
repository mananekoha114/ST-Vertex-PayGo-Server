/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

'use strict';

const { PluginError } = require('./errors.cjs');

// The one place that decides who may reach an administrator-only route. Routes
// supply their own error code and message so the reply still names what was
// refused, but the membership test itself lives here only.

function requireAuthenticatedUser(request) {
    if (!request.user || !request.user.directories) {
        throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
    }
}

function requireAdministrator(request, { code, message }) {
    requireAuthenticatedUser(request);
    if (request.user.profile?.admin !== true) {
        throw new PluginError(403, code, message);
    }
}

module.exports = { requireAdministrator, requireAuthenticatedUser };
