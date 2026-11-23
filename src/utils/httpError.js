export const httpError = (status, message, appCode, extra) => Object.assign(new Error(message), { status, appCode, extra });
