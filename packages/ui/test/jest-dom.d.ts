// jest-dom's own `@testing-library/jest-dom/vitest` augments the `vitest` it resolves from the
// workspace root, which is another major version than this package's when the workspaces differ.
// Declared here, `vitest` resolves to this package's copy, so the matchers type-check either way.
import "vitest";
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = any> extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<any, any> {}
}
