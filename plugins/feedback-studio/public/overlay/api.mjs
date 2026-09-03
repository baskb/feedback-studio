// Feedback Studio — the one call into the local server's REST API.

import { API } from '/__feedback/overlay/state.mjs';

// fetch + JSON with the error contract enforced: a non-2xx response throws
// (with the server's error message) instead of being mistaken for data —
// otherwise an { error } body would be pushed into `comments` as undefined.
// A network failure (server gone) throws a TypeError from fetch itself.
export async function api(path, opts) {
  let res;
  try { res = await fetch(API + path, opts); }
  catch (e) { const err = new Error('is the server running?'); err.network = true; throw err; }
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || ('server error ' + res.status));
  return data;
}
