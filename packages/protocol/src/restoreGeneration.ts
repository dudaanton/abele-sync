/** Opaque installation generation on every HTTP sync response. Clients echo it to
 * fence requests before receipt lookup or mutation. Missing means legacy behavior. */
export const RESTORE_GENERATION_HEADER = 'abele-restore-generation'
