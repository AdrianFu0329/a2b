// testapp-a2b.pages.dev: a short public address for A2B. Every request is passed through to the A2B Worker unchanged,
// so the page, the API and the sign-in cookie all live on this address.
const ORIGIN = 'https://a2b.thaqif.workers.dev';

export default {
  fetch(request) {
    const url = new URL(request.url);
    return fetch(new Request(ORIGIN + url.pathname + url.search, request));
  },
};
