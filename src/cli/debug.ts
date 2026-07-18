/** CLI debug output follows the codebase's existing truthy RBOX_DEBUG convention. */
export const debugEnabled = (): boolean => Boolean(process.env.RBOX_DEBUG);

