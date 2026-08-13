export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'Not allowed') => new ApiError(403, 'forbidden', msg);
export const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
export const conflict = (code, msg, details) => new ApiError(409, code, msg, details);
export const tooMany = (msg = 'Too many requests') => new ApiError(429, 'rate_limited', msg);
