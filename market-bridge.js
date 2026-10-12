(() => {
  if (!document.querySelector('meta[name="x-remark-market"]')) return;

  const targetOrigin = location.origin === "null" ? "*" : location.origin;
  const PAGES = new Set(["purchases", "creator", "bid"]);

  async function pushState() {
    const state = await chrome.runtime.sendMessage({ type: "MARKET_STATE" }).catch(() => null);
    window.postMessage({ source: "x-remark-ext", type: "STATE", ...(state || {}) }, targetOrigin);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "x-remark-web") return;
    const { type, listingId, page } = event.data;
    if (type === "PING") pushState();
    if (type === "BUY" && /^[\w-]{43}$/.test(String(listingId))) {
      chrome.runtime.sendMessage({ type: "OPEN_PAGE", hash: `buy=${listingId}` });
    }
    if (type === "OPEN" && PAGES.has(page)) {
      chrome.runtime.sendMessage({ type: "OPEN_PAGE", hash: page });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.x_purchases || changes.x_sync_wallet)) pushState();
  });

  pushState();
})();
