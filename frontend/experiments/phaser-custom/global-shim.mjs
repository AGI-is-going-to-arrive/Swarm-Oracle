const scope =
  typeof globalThis === 'object' && globalThis
    ? globalThis
    : typeof window === 'object' && window
      ? window
      : typeof self === 'object' && self
        ? self
        : {};

if (typeof scope.global === 'undefined') {
  scope.global = scope;
}
