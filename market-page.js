const $ = (id) => document.getElementById(id);

const state = {
  address: "",
  purchases: {},
  remarks: {},
  creator: null,
  buyListing: null,
  bids: null
};

function setStatus(text, isError = false) {
  const el = $("status");
  el.textContent = text || "";
  el.classList.toggle("error", isError);
}

async function busy(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await task();
  } catch (err) {
    setStatus(err.message || String(err), true);
    return null;
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function kickJobs() {
  chrome.runtime.sendMessage({ type: "RUN_JOBS" }).catch(() => {});
}

// ---------- routing ----------

function route() {
  const hash = location.hash.slice(1);
  if (hash.startsWith("buy=")) return { tab: "buy", listingId: hash.slice(4) };
  if (hash === "bid") return { tab: "creator", focusBid: true };
  return { tab: hash === "creator" ? "creator" : "purchases" };
}

function showTab() {
  const { tab, listingId, focusBid } = route();
  document.querySelectorAll("[data-tab]").forEach((a) => a.classList.toggle("active", a.dataset.tab === tab));
  document.querySelectorAll("[data-panel]").forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === "buy") loadBuy(listingId);
  if (tab === "creator") loadBids();
  if (focusBid) setTimeout(() => $("bid-card").scrollIntoView({ behavior: "smooth" }), 100);
}

window.addEventListener("hashchange", showTab);

// ---------- account ----------

async function renderAccount() {
  state.address = await Market.getAddress();
  const el = $("account");
  $("guide-address").textContent = state.address || "请先在扩展弹窗中创建账号";
  if (!state.address) {
    el.textContent = "未登录 · 请在扩展弹窗中创建或导入账号";
    return;
  }
  el.innerHTML = `<span class="addr" title="点击复制">${UI.shortAddr(state.address)}</span> <span id="balance">余额 …</span>`;
  el.querySelector(".addr").onclick = async () => {
    await navigator.clipboard.writeText(state.address);
    setStatus("地址已复制");
  };
  Market.getBalance()
    .then((w) => ($("balance").textContent = `余额 ${Chain.winstonToAr(w)} AR`))
    .catch(() => ($("balance").textContent = "余额 —"));
}

// ---------- buy ----------

function purchaseFor(listing) {
  return Object.values(state.purchases).find(
    (p) => p.creator === listing.creator && p.versionId === listing.versionId
  );
}

function renderBuy() {
  const box = $("buy-box");
  const l = state.buyListing;
  if (!l) return;
  const purchase = purchaseFor(l);
  let action = `<button class="btn primary big" id="confirm-buy">确认支付 ${l.priceAr} AR</button>`;
  if (!state.address) action = `<p class="error">请先在扩展弹窗中创建或导入账号，并充值 AR。</p>`;
  else if (l.creator === state.address) action = `<button class="btn" disabled>这是你自己的发布</button>`;
  else if (purchase?.status === "done") {
    action = `<button class="btn" data-resync="${purchase.purchaseId}">已拥有 · 免费重新同步</button>`;
  } else if (purchase?.status === "waiting") {
    action = `<button class="btn" disabled>已付款 · 自动发货中</button>`;
  } else if (purchase?.status === "paying") {
    action = `<button class="btn primary big" data-retry="${purchase.purchaseId}">继续完成付款</button>`;
  }

  box.innerHTML = `
    <div class="buy-head">
      <div>
        <div class="label">购买备注组</div>
        <h2>${UI.escapeHtml(l.title)}</h2>
        <div class="meta">${l.count} 条备注 · 创作者 ${UI.shortAddr(l.creator)} · 更新于 ${UI.formatTime(l.createdAt)}</div>
      </div>
      <div class="price big-price">${l.priceAr} AR</div>
    </div>
    ${l.description ? `<p class="desc">${UI.escapeHtml(l.description)}</p>` : ""}
    <div class="tags">${l.groups.map((g) => `<span class="tag">${UI.escapeHtml(g)}</span>`).join("")}</div>
    <ul class="hint list">
      <li>另需少量 Arweave 网络费，余额不足会提示。</li>
      <li>付款上链确认后由平台自动发货（通常 5~15 分钟），无需创作者在线，备注会自动同步到「${UI.escapeHtml(l.title)}/分组」下。</li>
      <li>同一版本以后重新同步免费；创作者更新新版本后需重新购买。</li>
    </ul>
    <div class="row">${action}</div>`;
}

async function loadBuy(listingId) {
  const box = $("buy-box");
  if (state.buyListing?.id !== listingId) {
    box.innerHTML = `<p class="hint">正在读取备注组信息…</p>`;
    try {
      const listings = await Market.fetchListings();
      state.buyListing = listings.find((l) => l.id === listingId) || null;
    } catch (err) {
      box.innerHTML = `<p class="error">${UI.escapeHtml(err.message)}</p>`;
      return;
    }
    if (!state.buyListing) {
      box.innerHTML = `<p class="error">没有找到这个备注组，可能已下架或已更新版本，请回到市场刷新后重试。</p>`;
      return;
    }
  }
  renderBuy();
}

$("buy-box").addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.id === "confirm-buy") {
    await busy(button, "付款中…", async () => {
      await Market.buy(state.buyListing);
      setStatus("付款已发送！上链确认后平台自动发货并同步，可在「我的购买」查看进度。");
      kickJobs();
    });
  }
  if (button.dataset.retry) await retry(button, button.dataset.retry);
  if (button.dataset.resync) await resync(button, button.dataset.resync);
});

// ---------- purchases ----------

async function retry(button, purchaseId) {
  await busy(button, "重试中…", async () => {
    await Market.retryPurchase(purchaseId);
    setStatus("付款已发送，上链确认后自动发货");
    kickJobs();
  });
}

async function resync(button, purchaseId) {
  await busy(button, "同步中…", async () => {
    const { added } = await Market.resync(purchaseId);
    setStatus(`同步完成，新增 ${added} 条备注`);
  });
}

const PURCHASE_STATUS = {
  paying: "付款未完成",
  waiting: "已付款，等待上链确认后自动发货（通常 5~15 分钟）",
  done: "已同步"
};

function renderPurchases() {
  const list = Object.values(state.purchases).sort((a, b) => b.createdAt - a.createdAt);
  const box = $("purchases");
  if (!list.length) {
    box.innerHTML = `<p class="empty">还没有购买记录，去<a href="${CONFIG.MARKET_URL}" target="_blank">备注市场</a>逛逛吧。</p>`;
    return;
  }
  box.innerHTML = list
    .map((p) => {
      let action = "";
      if (p.status === "paying") action = `<button class="btn primary" data-retry="${p.purchaseId}">重试付款</button>`;
      if (p.status === "waiting") action = `<button class="btn" data-check="1">立即检查</button>`;
      if (p.status === "done") action = `<button class="btn" data-resync="${p.purchaseId}">免费重新同步</button>`;
      return `
        <article class="card purchase">
          <div>
            <h3>${UI.escapeHtml(p.title)}</h3>
            <div class="meta">
              ${Chain.winstonToAr(p.priceWinston)} AR · ${UI.formatTime(p.createdAt)} · 创作者 ${UI.shortAddr(p.creator)}
            </div>
            <div class="state ${p.status}">
              ${PURCHASE_STATUS[p.status] || p.status}${p.status === "done" ? ` · ${UI.formatTime(p.syncedAt)}` : ""}
              ${p.error ? `<span class="error">（${UI.escapeHtml(p.error)}）</span>` : ""}
            </div>
          </div>
          ${action}
        </article>`;
    })
    .join("");
}

$("purchases").addEventListener("click", async (e) => {
  const button = e.target.closest("button");
  if (!button) return;
  if (button.dataset.retry) await retry(button, button.dataset.retry);
  if (button.dataset.resync) await resync(button, button.dataset.resync);
  if (button.dataset.check) {
    await busy(button, "检查中…", async () => {
      const result = await chrome.runtime.sendMessage({ type: "RUN_JOBS" });
      setStatus(result?.claimed ? `已同步 ${result.claimed} 个购买` : "还在等待链上确认，稍后会自动同步");
    });
  }
});

// ---------- creator ----------

function renderSplit() {
  const el = $("c-split");
  try {
    const price = Chain.arToWinston($("c-price").value || "0");
    const { creatorPart } = Chain.splitPrice(price);
    el.textContent = `平台服务费 30%，每次售出你实得 ${Chain.winstonToAr(creatorPart)} AR`;
  } catch {
    el.textContent = "平台服务费 30%";
  }
}

function renderCreatorGroups() {
  const box = $("c-groups");
  const checked = new Set(
    box.dataset.touched
      ? [...box.querySelectorAll("input:checked")].map((i) => i.value)
      : state.creator?.groups || []
  );
  const own = Object.values(state.remarks).filter((e) => !e.source);
  const groups = RemarkStore.groupsOf(state.remarks, { ownOnly: true });
  if (!groups.length) {
    box.innerHTML = `<p class="hint">你还没有自己写的备注。</p>`;
    return;
  }
  box.innerHTML = groups
    .map((g) => {
      const count = own.filter((e) => e.group === g).length;
      return `
        <label class="check">
          <input type="checkbox" value="${UI.escapeHtml(g)}" ${checked.has(g) ? "checked" : ""} />
          ${UI.escapeHtml(g || RemarkStore.UNGROUPED)} <span>${count}</span>
        </label>`;
    })
    .join("");
}

function renderCreator() {
  const creator = state.creator;
  const current = creator.current ? creator.versions[creator.current] : null;
  $("creator-stats").innerHTML = `
    <div class="stats">
      <div><strong>${current ? "已上架" : "未上架"}</strong><span>状态</span></div>
      <div><strong>${creator.sales}</strong><span>累计售出</span></div>
      <div><strong>${Chain.winstonToAr(creator.earnedWinston)} AR</strong><span>累计收入</span></div>
    </div>
    ${
      current
        ? `<p class="hint">当前版本：${UI.escapeHtml(current.title)} · ${current.count} 条 · ${Chain.winstonToAr(current.priceWinston)} AR · ${UI.formatTime(current.createdAt)}</p>`
        : ""
    }`;
  $("publish-btn").textContent = current ? "更新" : "发布";
  $("close-btn").hidden = !current;
}

function fillCreatorForm() {
  $("c-title").value = state.creator.title;
  $("c-desc").value = state.creator.description;
  $("c-price").value = state.creator.price;
  renderSplit();
}

$("c-price").addEventListener("input", renderSplit);
$("c-groups").addEventListener("change", (e) => {
  e.currentTarget.dataset.touched = "1";
});

$("creator-form").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!state.address) {
    setStatus("请先在扩展弹窗中创建或导入账号", true);
    return;
  }
  busy($("publish-btn"), "发布中…", async () => {
    const version = await Market.publishListing({
      title: $("c-title").value,
      description: $("c-desc").value,
      price: $("c-price").value,
      groups: [...$("c-groups").querySelectorAll("input:checked")].map((i) => i.value)
    });
    setStatus(`已免费发布 ${version.count} 条备注，几分钟内会出现在市场中`);
  });
});

$("close-btn").addEventListener("click", (e) => {
  if (!confirm("确定下架？已购买的用户不受影响。")) return;
  busy(e.target, "下架中…", async () => {
    await Market.closeListing();
    setStatus("已下架，几分钟后从市场中消失");
  });
});

// ---------- bidding ----------

function renderBids() {
  const board = $("bid-board");
  if (!state.bids) {
    board.innerHTML = `<p class="hint">正在读取竞价排名…</p>`;
    return;
  }
  const rows = state.bids.slice(0, CONFIG.PROMO_SLOTS);
  const myIndex = state.bids.findIndex((b) => b.creator === state.address);
  const mine = myIndex >= 0 ? state.bids[myIndex].winston : 0n;
  board.innerHTML = rows.length
    ? rows
        .map(
          (b, i) => `
          <div class="bid-row ${b.creator === state.address ? "me" : ""}">
            <span class="bid-rank">${i + 1}</span>
            <span class="addr">${b.creator === state.address ? "我" : UI.shortAddr(b.creator)}</span>
            <strong>${Chain.winstonToAr(b.winston)} AR</strong>
          </div>`
        )
        .join("")
    : `<p class="hint">当前竞价位全部空缺，任意出价即可排第 1。</p>`;

  const last = rows.length >= CONFIG.PROMO_SLOTS ? rows[rows.length - 1].winston : 0n;
  const top = rows[0]?.winston || 0n;
  const parts = [
    myIndex >= 0 ? `你近 7 天累计出价 ${Chain.winstonToAr(mine)} AR，当前第 ${myIndex + 1} 名。` : "你目前不在竞价位上。"
  ];
  if (top > mine && rows[0]?.creator !== state.address) {
    parts.push(`追加超过 ${Chain.winstonToAr(top - mine)} AR 即可登顶。`);
  }
  if (last > 0n && myIndex < 0) parts.push(`进入前 ${CONFIG.PROMO_SLOTS} 至少需要超过 ${Chain.winstonToAr(last)} AR。`);
  $("bid-hint").textContent = parts.join(" ");
}

async function loadBids() {
  renderBids();
  try {
    state.bids = await Market.fetchBids();
  } catch (err) {
    state.bids = [];
    setStatus(err.message, true);
  }
  renderBids();
}

$("bid-btn").addEventListener("click", (e) => {
  const amount = $("bid-amount").value.trim();
  if (!amount) {
    setStatus("请输入出价金额", true);
    return;
  }
  if (!confirm(`确认出价 ${amount} AR 用于竞价推广？出价不可退回，7 天内有效。`)) return;
  busy(e.target, "出价中…", async () => {
    await Market.placeBid(amount);
    $("bid-amount").value = "";
    setStatus("出价成功！链上确认后会出现在市场竞价位（通常几分钟）。");
    await renderAccount();
    await loadBids();
  });
});

// ---------- data ----------

async function loadLocal() {
  const [purchases, remarks, creator] = await Promise.all([
    Market.getPurchases(),
    RemarkStore.getAll(),
    Market.getCreator()
  ]);
  const firstLoad = !state.creator;
  Object.assign(state, { purchases, remarks, creator });
  if (firstLoad) fillCreatorForm();
  renderCreatorGroups();
  renderCreator();
  renderPurchases();
  renderBuy();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const keys = CONFIG.KEYS;
  if (changes[keys.WALLET]) renderAccount();
  if (changes[keys.PURCHASES] || changes[keys.REMARKS] || changes[keys.CREATOR]) loadLocal();
});

$("buy-link").href = CONFIG.BUY_AR_URL;
$("market-link").href = CONFIG.MARKET_URL;

(async () => {
  await renderAccount();
  await loadLocal();
  showTab();
  kickJobs();
})();
