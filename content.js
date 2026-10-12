(() => {
  const NAME_BLOCK_SELECTOR = '[data-testid="UserName"], [data-testid="User-Name"]';
  const LINK_SKIP_SELECTOR =
    '[data-testid="UserName"], nav, [role="navigation"], [data-testid="AppTabBar_Profile_Link"], #x-remark-modal';
  const MENTION_SCOPE_SELECTOR = '[data-testid="tweetText"], [data-testid="UserDescription"], [data-testid="messageEntry"]';
  const HANDLE_ONLY_SELECTOR = '[data-testid="conversation"], [data-testid="TypeaheadUser"]';
  const RESERVED = new Set([
    "home", "explore", "notifications", "messages", "i", "settings", "search", "compose",
    "login", "signup", "intent", "hashtag", "tos", "privacy", "about", "help", "jobs",
    "download", "share", "status", "logout", "account", "premium", "verified-choose"
  ]);
  const PROFILE_HREF = /^(?:https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com)?\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/i;
  const HANDLE_TEXT = /^@([A-Za-z0-9_]{1,15})$/;

  let remarks = {};
  let renderTimer = null;

  function profileFromHref(href) {
    const match = href && href.match(PROFILE_HREF);
    if (!match || RESERVED.has(match[1].toLowerCase())) return null;
    return match[1].toLowerCase();
  }

  function handleOf(el) {
    const match = el.textContent.trim().match(HANDLE_TEXT);
    return match ? match[1].toLowerCase() : null;
  }

  function findHandleElement(root) {
    for (const el of root.querySelectorAll("span, a")) {
      if (el.children.length === 0 && handleOf(el)) return el;
    }
    return null;
  }

  function findUsername(block) {
    for (const a of block.querySelectorAll("a[href]")) {
      const username = profileFromHref(a.getAttribute("href"));
      if (username) return username;
    }
    const handle = findHandleElement(block);
    if (handle) return handleOf(handle);
    const match = block.textContent.match(/@([A-Za-z0-9_]{1,15})/);
    return match ? match[1].toLowerCase() : null;
  }

  function handleRowOf(block) {
    let node = findHandleElement(block);
    if (!node) return null;
    while (node.parentElement && node.parentElement !== block && !node.previousElementSibling) {
      node = node.parentElement;
    }
    return node.parentElement ? node : null;
  }

  function buildPill(tag, className, username, entry, sig) {
    const el = document.createElement(tag);
    el.className = className;
    el.dataset.user = username;
    el.dataset.sig = sig;
    el.title = entry.source ? `来自「${entry.source.title}」，点击编辑` : "点击编辑备注";
    el.innerHTML = `
      <span class="x-remark-pill name">${UI.escapeHtml(entry.remark)}</span>
      ${entry.group ? `<span class="x-remark-pill group">${UI.escapeHtml(entry.group)}</span>` : ""}
    `;
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditor(username);
    });
    return el;
  }

  // ---------- profile header: remark row between name and @handle ----------

  function renderHeader(block) {
    const username = findUsername(block);
    const existing = block.querySelector(".x-remark-meta");
    const entry = username ? remarks[username] : null;
    if (!entry) {
      existing?.remove();
      return;
    }
    const sig = `${username}|${entry.remark}|${entry.group}`;
    if (existing?.dataset.sig === sig) return;
    existing?.remove();
    const meta = buildPill("div", "x-remark-meta", username, entry, sig);
    const row = handleRowOf(block);
    if (row) row.insertAdjacentElement("beforebegin", meta);
    else block.appendChild(meta);
  }

  // ---------- everywhere else: pill right after the name / @mention ----------

  function upsertInline(target, username, variant) {
    const entry = remarks[username];
    const next = target.nextElementSibling;
    const pill = next?.classList.contains("x-remark-inline") ? next : null;
    if (!entry) {
      pill?.remove();
      return;
    }
    const shown = variant === "mention" ? { ...entry, group: "" } : entry;
    const sig = `${variant}|${username}|${entry.remark}|${shown.group}`;
    if (pill?.dataset.sig === sig) return;
    pill?.remove();
    const className = variant === "mention" ? "x-remark-inline mention" : "x-remark-inline";
    target.insertAdjacentElement("afterend", buildPill("span", className, username, shown, sig));
  }

  function targetUserOf(el) {
    if (!el) return null;
    return el.tagName === "A" ? profileFromHref(el.getAttribute("href")) : handleOf(el);
  }

  function removeStalePills() {
    for (const pill of document.querySelectorAll(".x-remark-inline")) {
      if (targetUserOf(pill.previousElementSibling) !== pill.dataset.user || !remarks[pill.dataset.user]) {
        pill.remove();
      }
    }
  }

  function renderLinks() {
    for (const a of document.querySelectorAll("a[href]")) {
      const username = profileFromHref(a.getAttribute("href"));
      if (!username || a.closest(LINK_SKIP_SELECTOR)) continue;
      const text = a.textContent.trim();
      if (!text) continue;
      const mention = text.match(HANDLE_TEXT);
      if (mention) {
        if (mention[1].toLowerCase() === username && a.closest(MENTION_SCOPE_SELECTOR)) {
          upsertInline(a, username, "mention");
        }
        continue;
      }
      upsertInline(a, username, "name");
    }
  }

  function renderHandleOnly() {
    for (const box of document.querySelectorAll(HANDLE_ONLY_SELECTOR)) {
      const handle = findHandleElement(box);
      if (!handle) continue;
      const attachedElsewhere = [...box.querySelectorAll(".x-remark-inline")].some(
        (pill) => pill.previousElementSibling !== handle
      );
      if (!attachedElsewhere) upsertInline(handle, handleOf(handle), "name");
    }
  }

  // ---------- profile page button ----------

  function profileUsername() {
    const parts = location.pathname.split("/").filter(Boolean);
    return parts.length === 1 ? profileFromHref(`/${parts[0]}`) : null;
  }

  function renderProfileButton() {
    const username = profileUsername();
    let btn = document.getElementById("x-remark-profile-btn");
    const actions = document.querySelector('[data-testid="userActions"]');
    if (!username || !actions) {
      btn?.remove();
      return;
    }
    if (!btn) {
      btn = document.createElement("button");
      btn.id = "x-remark-profile-btn";
      btn.type = "button";
      btn.className = "x-remark-profile-btn";
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openEditor(btn.dataset.user);
      });
    }
    if (btn.nextElementSibling !== actions) actions.insertAdjacentElement("beforebegin", btn);
    const label = remarks[username] ? "编辑备注" : "添加备注";
    if (btn.dataset.user !== username) btn.dataset.user = username;
    if (btn.textContent !== label) btn.textContent = label;
  }

  function renderAll() {
    removeStalePills();
    document.querySelectorAll('[data-testid="UserName"]').forEach(renderHeader);
    if (Object.keys(remarks).length) {
      renderLinks();
      renderHandleOnly();
    }
    renderProfileButton();
  }

  function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      renderAll();
    }, 120);
  }

  function ensureModal() {
    let modal = document.getElementById("x-remark-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.id = "x-remark-modal";
    modal.innerHTML = `
      <div class="x-remark-backdrop"></div>
      <div class="x-remark-dialog" role="dialog" aria-modal="true">
        <h3>设置备注</h3>
        <p class="x-remark-user">@<span data-role="username"></span></p>
        <input type="text" data-role="remark" maxlength="40" placeholder="备注名，留空则删除" />
        <input type="text" data-role="group" maxlength="40" placeholder="分组（可选）" list="x-remark-groups" />
        <datalist id="x-remark-groups"></datalist>
        <div class="x-remark-actions">
          <button type="button" data-role="delete" class="x-remark-btn danger">删除</button>
          <div class="x-remark-actions-right">
            <button type="button" data-role="cancel" class="x-remark-btn ghost">取消</button>
            <button type="button" data-role="save" class="x-remark-btn primary">保存</button>
          </div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(modal);

    const close = () => modal.classList.remove("open");
    const save = async (remark, group) => {
      const username = modal.dataset.username;
      try {
        remarks = await RemarkStore.set(username, remark, group);
        close();
        renderAll();
        showToast(remark ? `已保存 @${username} 的备注` : `已删除 @${username} 的备注`);
      } catch (err) {
        showToast(err.message);
      }
    };
    const remarkInput = modal.querySelector('[data-role="remark"]');
    const groupInput = modal.querySelector('[data-role="group"]');

    modal.querySelector(".x-remark-backdrop").addEventListener("click", close);
    modal.querySelector('[data-role="cancel"]').addEventListener("click", close);
    modal.querySelector('[data-role="save"]').addEventListener("click", () => {
      save(remarkInput.value.trim(), groupInput.value.trim());
    });
    modal.querySelector('[data-role="delete"]').addEventListener("click", () => save("", ""));
    modal.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        save(remarkInput.value.trim(), groupInput.value.trim());
      }
      if (e.key === "Escape") close();
    });
    return modal;
  }

  function openEditor(username) {
    const modal = ensureModal();
    const entry = remarks[username] || { remark: "", group: "" };
    modal.dataset.username = username;
    modal.querySelector('[data-role="username"]').textContent = username;
    modal.querySelector('[data-role="remark"]').value = entry.remark;
    modal.querySelector('[data-role="group"]').value = entry.group;
    modal.querySelector("#x-remark-groups").innerHTML = RemarkStore.groupsOf(remarks)
      .filter(Boolean)
      .map((g) => `<option value="${UI.escapeHtml(g)}"></option>`)
      .join("");
    modal.classList.add("open");
    setTimeout(() => modal.querySelector('[data-role="remark"]').focus(), 50);
  }

  function showToast(message) {
    let toast = document.getElementById("x-remark-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "x-remark-toast";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[RemarkStore.KEY]) return;
    remarks = RemarkStore.normalizeAll(changes[RemarkStore.KEY].newValue);
    renderAll();
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === "PROMPT_REMARK" && message.username) openEditor(message.username);
  });

  document.addEventListener(
    "dblclick",
    (e) => {
      const block = e.target instanceof Element ? e.target.closest(NAME_BLOCK_SELECTOR) : null;
      const username = block && findUsername(block);
      if (!username) return;
      e.preventDefault();
      e.stopPropagation();
      openEditor(username);
    },
    true
  );

  async function init() {
    remarks = await RemarkStore.getAll();
    renderAll();
    new MutationObserver(scheduleRender).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
