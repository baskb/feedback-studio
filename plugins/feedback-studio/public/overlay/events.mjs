// Feedback Studio — a four-line event bus.
//
// The overlay's modules are layered: a lower module never imports a higher one.
// The handful of calls that DO run upward (a pin asking the panel to focus a
// card, the composer asking for a re-render) go through here instead, so the
// import graph stays acyclic. Handlers are registered once in boot.mjs, before
// anything can fire, and are called synchronously in registration order — an
// emit() behaves exactly like the direct call it replaced, exceptions included.

const handlers = new Map();

export function on(name, fn) {
  if (!handlers.has(name)) handlers.set(name, []);
  handlers.get(name).push(fn);
}

export function emit(name, detail) {
  const list = handlers.get(name);
  if (!list) return;
  for (const fn of list.slice()) fn(detail);
}
