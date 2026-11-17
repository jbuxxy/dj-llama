import type { Context } from 'hono'

// RFC 9457 "Problem Details for HTTP APIs" envelope. Used by the top-level
// onError handler and any route that returns a structured error. Keeping
// `type` as a relative slug keeps the response payload small and avoids
// baking in the public domain — clients treat it as an opaque token.
//
// `code` is a stable machine-readable error code (e.g. `errors.target.notFound`)
// for clients that need to branch on a specific failure; `title` is the
// human-readable message.

export type ProblemBody = {
  type: string
  title: string
  status: number
  code?: string
  detail?: string
  [extension: string]: unknown
}

export function problem(
  c: Context,
  type: string,
  title: string,
  status: number,
  detail?: string,
  extensions?: Record<string, unknown>,
  code?: string,
) {
  const body: ProblemBody = {
    type: `/problems/${type}`,
    title,
    status,
    ...(code !== undefined ? { code } : {}),
    ...(detail !== undefined ? { detail } : {}),
    ...(extensions ?? {}),
  }
  return c.json(body, status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503, {
    'content-type': 'application/problem+json',
  })
}

export function notFoundProblem(c: Context, type: string, title: string, code: string) {
  return problem(c, type, title, 404, undefined, undefined, code)
}

const STATUS_SLUGS: Record<number, string> = {
  400: 'bad-request',
  401: 'not-authenticated',
  403: 'forbidden',
  404: 'not-found',
  409: 'conflict',
  413: 'payload-too-large',
  415: 'unsupported-media-type',
  422: 'unprocessable',
  429: 'rate-limited',
  500: 'internal-error',
  502: 'upstream-error',
  503: 'unavailable',
  504: 'upstream-timeout',
}

/**
 * The everyday error response: a problem+json body whose `title` is the
 * message to show. `extensions` carries any extra fields a client branches
 * on (`code`, `fields`, ...). Use `problem()` directly when a stable `type`
 * slug or a separate `detail` matters.
 */
export function apiError(
  c: Context,
  status: number,
  message: string,
  extensions?: Record<string, unknown>,
) {
  return problem(
    c,
    STATUS_SLUGS[status] ?? `http-${status}`,
    message,
    status,
    undefined,
    extensions,
  )
}
