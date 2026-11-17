export type AuthMethod =
  | 'session-bearer'
  | 'session-cookie'
  | 'session-query'
  | 'legacy-bearer'
  | 'legacy-query'

export type HonoEnv = {
  Variables: {
    userId?: number
    authMethod?: AuthMethod
    legacyTokenAuth?: boolean
  }
}
