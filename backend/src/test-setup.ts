/**
 * Test preload. Runs before any test module is imported (see bunfig.toml).
 *
 * config.ts refuses to start without AUTH_JWT_SECRET and exits the process -
 * that is deliberate, so a production box can never boot on a fallback secret.
 * The side effect is that any test importing a module which transitively pulls
 * config would kill the whole run, so the value is supplied here rather than
 * being repeated in each test file.
 */
process.env.AUTH_JWT_SECRET ||= "test-only-secret-never-used-outside-the-test-runner-0123456789";
