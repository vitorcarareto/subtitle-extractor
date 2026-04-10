// Runs in the page's MAIN world (same JS context as YouTube's player).
// Proxies fetch requests from the isolated-world content script via DOM events.
// This ensures requests include YouTube's session cookies and match the page's origin.

document.addEventListener('__subtitle_ext_fetch', ((e: CustomEvent) => {
  const { url, requestId } = e.detail;
  fetch(url)
    .then((r) => r.ok ? r.text() : Promise.reject(r.status))
    .then((text) => {
      document.dispatchEvent(new CustomEvent('__subtitle_ext_fetch_result', {
        detail: { requestId, text },
      }));
    })
    .catch((err) => {
      document.dispatchEvent(new CustomEvent('__subtitle_ext_fetch_result', {
        detail: { requestId, error: String(err) },
      }));
    });
}) as EventListener);
