export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    console.log('[instrumentation] Server started — Claude AI mode (API-only, no auto-trading)');
    console.log('[instrumentation] Skill APIs ready at /api/skills/*');
  }
}
