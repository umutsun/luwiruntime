/**
 * UTF-8 byte length, without `Buffer`.
 *
 * `Buffer` is a Node global, not a language one. Schemas that used it parsed
 * fine on the daemon and threw `ReferenceError: Buffer is not defined` the
 * moment the dashboard validated the same payload — and because the failure is
 * a runtime exception rather than a validation error, `safeParse` did not catch
 * it and the panel hung on its loading state instead of reporting a fault.
 *
 * `TextEncoder` is a Web API present in browsers and in Node since v11, so one
 * implementation now serves both sides of the boundary AGENTS.md section 5
 * draws. The `apps/dashboard/vite.config.test.ts` bundle guard cannot catch a
 * bare global the way it catches an `import`, which is why this is a shared
 * helper rather than a rule.
 */
const encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).length;
}
