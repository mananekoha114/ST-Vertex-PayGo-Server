'use strict';

const { PluginError, sendExpressError } = require('./errors.cjs');
const { validateChatId, validateUsageIds } = require('./protocol.cjs');

function createUsageHandler({ usageStore }) {
    return function usageHandler(request, response) {
        try {
            if (!request.user?.directories?.root) {
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
            }
            const chatId = validateChatId(request.query?.chatId);
            response.set?.('Cache-Control', 'no-store');
            if (request.query?.ids !== undefined) {
                if (request.query?.cursor !== undefined || request.query?.limit !== undefined) {
                    throw new PluginError(400, 'INVALID_USAGE_PAGE', 'ids cannot be combined with cursor or limit.');
                }
                const ids = validateUsageIds(request.query.ids);
                const result = usageStore.getByIds(request.user, chatId, ids);
                if (!result) throw new PluginError(400, 'INVALID_USAGE_IDS', 'Invalid usage IDs.');
                return response.json({ ok: true, ...result });
            }
            const page = usageStore.list(request.user, chatId, {
                cursor: request.query?.cursor,
                limit: request.query?.limit,
            });
            if (!page) throw new PluginError(400, 'INVALID_USAGE_PAGE', 'Invalid usage page cursor or limit.');
            return response.json({ ok: true, ...page });
        } catch (error) {
            return sendExpressError(response, error);
        }
    };
}

module.exports = { createUsageHandler };
