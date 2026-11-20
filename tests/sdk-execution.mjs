export function withSdkExecutionBudget(register) {
  return (...args) => {
    const [name, optionsOrBody, body] = args
    const short = args.length === 2 && typeof optionsOrBody === 'function'
    const options = short ? {} : optionsOrBody
    const callback = short ? optionsOrBody : body
    if ((!short && args.length !== 3) || !options || typeof options !== 'object' || Array.isArray(options) || typeof callback !== 'function') {
      throw new TypeError(`SDK test ${JSON.stringify(name)} expected a callback, or options and a callback`)
    }
    const asynchronous = Object.prototype.toString.call(callback) === '[object AsyncFunction]'
    if (options.timeoutMs === undefined && !asynchronous) return register(...args)
    return register(name, { ...options, timeoutMs: options.timeoutMs === undefined ? 30_000 : options.timeoutMs }, callback)
  }
}
