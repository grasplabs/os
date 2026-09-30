/**
 * A setup file for the test projects that run in workerd: fails the suite
 * when it runs anywhere else. Were the Workers pool not to start, Vitest
 * would run the files in Node, and only those importing `cloudflare:test`
 * or `cloudflare:workers` would notice; the rest (the SDK's, the router's
 * pure ones) would pass against the wrong runtime. workerd's user agent is
 * fixed; Node's names Node.
 */
if (navigator.userAgent !== "Cloudflare-Workers") {
  throw new Error(
    `These tests must run in workerd, but navigator.userAgent is ${JSON.stringify(navigator.userAgent)}: the Workers test pool did not start. Fix the pool; don't remove this check.`
  );
}
