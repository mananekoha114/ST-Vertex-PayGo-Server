/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */
'use strict';
const { PluginError, sendExpressError } = require('./errors.cjs');

function registerDataBackupRoutes(router, dataBackups) {
    function handler(action) {
        return (request, response) => {
            response.set?.('Cache-Control', 'no-store');
            try { return response.json(action(request)); }
            catch (error) { return sendExpressError(response, error); }
        };
    }
    router.get('/data-backups', handler(request => dataBackups.list(request, {
        ...(request.query?.limit !== undefined ? { limit: Number(request.query.limit) } : {}),
        ...(request.query?.cursor !== undefined ? { cursor: request.query.cursor } : {}),
    })));
    router.post('/data-restore', handler(request => {
        if (!request.body || typeof request.body.backupId !== 'string' || Object.keys(request.body).some(key => key !== 'backupId')) {
            throw new PluginError(400, 'DATA_BACKUP_INVALID_ID', 'Choose a data backup to restore.');
        }
        return dataBackups.schedule(request, request.body.backupId);
    }));
    router.post('/data-restore/cancel', handler(request => dataBackups.cancel(request)));
}
module.exports = { registerDataBackupRoutes };
