(() => {
  const BLOCK_SELECTOR = '[data-testid="UserName"], [data-testid="User-Name"]';
  const RESERVED = new Set([
    "home", "explore", "notifications", "messages", "i", "settings", "search", "compose",
    "login", "signup", "intent", "hashtag", "tos", "privacy", "about", "help", "jobs",
    "download", "share", "status"
  ]);

  let remarks = {};
  let scheduled = false;

  function usernameFromHref(href) {
    try {
      const url = new URL(href, location.origin);
      if (!/(^|\.)(x|twitter)\.com$/i.test(url.hostname)) return null;
      const [first, second] = url.pathname.split("/").filter(Boolean);
      if (!first || second || RESERVED.has(first.toLowerCase())) return null;
      return /^[A-Za-z0-9_]{1,15}$/.test(first) ? first.toLowerCase() : null;
    } catch {
      return null;
    }
  }

  function findHandleElement(block) {
    for (const el of block.querySelectorAll("span, a")) {
      if (el.children.length === 0 && /^@[A-Za-z0-9_]{1,15}$/.test(el.textContent.trim())) return el;
    }
    return null;
  }

  function findUsername(block) {
    for (const a of block.querySelectorAll("a[href]")) {
      const username = usernameFromHref(a.getAttribute("href"));
      if (username) return username;
    }
    const handle = findHandleElement(block);
    if (handle) return handle.textContent.trim().slice(1).toLowerCase();
    const match = block.textContent.match(/@([A-Za-z0-9_]{1,15})/);
    return match ? match[1].toLowerCase() : null;
  }

  function findNameAnchor(block, username) {
    for (const a of block.querySelectorAll("a[href]")) {
      if (usernameFromHref(a.getAttribute("href")) !== username) continue;
      const text = a.textContent.trim();
      if (text && !text.startsWith("@")) return a;
    }
    return null;
  }

  function handleRowOf(block) {
    let node = findHandleElement(block);
    if (!node) return null;
    while (node.parentElement && node.parentElement !== block && !node.previousElementSibling) {
      node = node.parentElement;
    }
    return node.parentElement ? node : null;
  }

  function buildMeta(className, username, entry, sig) {
    const meta = document.createElement(className === "x-remark-meta" ? "div" : "span");
    meta.className = className;
    meta.dataset.user = username;
    meta.dataset.sig = sig;
    meta.title = entry.source ? `来自「${entry.source.title}」，点击编辑` : "点击编辑备注";
    meta.innerHTML = `
      <span class="x-remark-pill name">${UI.escapeHtml(entry.remark)}</span>
      ${entry.group ? `<span class="x-remark-pill group">${UI.escapeHtml(entry.group)}</span>` : ""}
    `;
    meta.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openEditor(username);
    });
    return meta;
  }

  function renderBlock(block) {
    const username = findUsername(block);
    const existing = block.querySelector(".x-remark-meta, .x-remark-inline");
    const entry = username ? remarks[username] : null;
    if (!entry) {
      existing?.remove();
      return;
    }
    const sig = `${username}|${entry.remark}|${entry.group}`;
    if (existing?.dataset.sig === sig) return;
    existing?.remove();

    if (block.dataset.testid === "UserName") {
      const meta = buildMeta("x-remark-meta", username, entry, sig);
      const row = handleRowOf(block);
      if (row) row.insertAdjacentElement("beforebegin", meta);
      else block.appendChild(meta);
      return;
    }

    const meta = buildMeta("x-remark-inline", username, entry, sig);
    const anchor = findNameAnchor(block, username);
    if (anchor) anchor.insertAdjacentElement("afterend", meta);
    else block.prepend(meta);
  }

  function profileUsername() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length !== 1) return null;
    return usernameFromHref(`/${parts[0]}`);
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
    document.querySelectorAll(BLOCK_SELECTOR).forEach(renderBlock);
    renderProfileButton();
  }

  function scheduleRender() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      renderAll();
    });
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
      const block = e.target instanceof Element ? e.target.closest(BLOCK_SELECTOR) : null;
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
