// Sample: module-location data. `import.meta.url` is a local filesystem URL
// under Node and a deployed URL in a browser, so anything derived from it that
// reaches state makes replay depend on where the code lives. Violates
// invariant 3 on purpose.
export const HERE = new URL(".", import.meta.url).pathname;
