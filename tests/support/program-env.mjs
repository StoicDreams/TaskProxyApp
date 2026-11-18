// The environment for programs a spec starts, the same wherever the tests run: the run's own settings, such as CI's
// and Publish's, are left out, so a script never behaves differently on CI, in a full run, or beside other specs.
// (tests/app/scripts.spec.mjs has its own copy, since it is shared with every site.)
const RUN_SETTINGS = ['CI', 'GITHUB_ACTIONS', 'PW_NO_CACHE', 'PW_WORKERS', 'PW_NICE', 'PW_TEST_CACHE_ROOT', 'WEBUI_CDN_ROOT', 'TASKPROXY_CDN'];
export function programEnv(env = {}) {
    const clean = { ...process.env };
    for (const key of Object.keys(clean)) if (RUN_SETTINGS.includes(key.toUpperCase())) delete clean[key];
    return { ...clean, ...env };
}
