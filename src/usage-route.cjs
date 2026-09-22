'use strict';

const { PluginError, sendExpressError } = require('./errors.cjs');
const { validateChatId } = require('./protocol.cjs');

function createUsageHandler({ usageStore }) {
    return function usageHandler(request, response) {
        try {
            if (!request.user?.directories?.root) {
                throw new PluginError(401, 'AUTHENTICATED_USER_REQUIRED', 'An authenticated SillyTavern user is required.');
            }
            const chatId = validateChatId(request.query?.chatId);
            response.set?.('Cache-Control', 'no-store');
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
