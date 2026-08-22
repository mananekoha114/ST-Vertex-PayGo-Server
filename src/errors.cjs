'use strict';

class PluginError extends Error {
    constructor(status, code, message, options = undefined) {
        super(message, options);
        this.name = 'PluginError';
        this.status = status;
        this.code = code;
    }
}

function asPluginError(error) {
    if (error instanceof PluginError) {
        return error;
    }

    return new PluginError(
        500,
        'INTERNAL_ERROR',
        'The Vertex PayGo server plugin could not complete the request.',
        { cause: error },
    );
}

function sendExpressError(response, error) {
    const safeError = asPluginError(error);
    return response.status(safeError.status).json({
        error: true,
        code: safeError.code,
        message: safeError.message,
    });
}

function sendNodeError(response, error) {
    const safeError = asPluginError(error);
    if (response.headersSent || response.writableEnded) {
        response.destroy();
        return;
    }

    const body = Buffer.from(JSON.stringify({
        error: true,
        code: safeError.code,
        message: safeError.message,
    }));

    response.writeHead(safeError.status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
    });
    response.end(body);
}

module.exports = {
    PluginError,
    asPluginError,
    sendExpressError,
    sendNodeError,
};
