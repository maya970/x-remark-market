const $ = (id) => document.getElementById(id);

let remarks = {};
let groupFilterValue = "*";

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

function openMarket(target) {
  const url = target === "market" ? CONFIG.MARKET_URL : chrome.runtime.getURL(`market.html#${target}`);
  chrome.tabs.create({ url });
}

async function renderAccount() {
  const address = await Market.getAddress();
  $("guest-card").hidden = Boolean(address);
  $("user-card").hidden = !address;
  if (!address) return;

  const addressEl = $("address");
  addressEl.textContent = UI.shortAddr(address);
  addressEl.dataset.full = address;

  const backup = await Market.getBackupInfo();
  $("backup-info").textContent = backup
    ? `上次备份：${UI.formatTime(backup.at)}（${backup.count} 条）`
    : "还没有云端备份，上传完全免费";
  $("creator-link").classList.toggle("highlight", Boolean(backup));

  Market.getBalance()
    .then((winston) => {
      $("balance").textContent = `余额 ${Chain.winstonToAr(winston)} AR`;
    })
    .catch(() => {
      $("balance").textContent = "余额 —";
    });
}

function renderGroupControls() {
  const groups = RemarkStore.groupsOf(remarks);
  $("group-options").innerHTML = groups
    .filter(Boolean)
    .map((g) => `<option value="${UI.escapeHtml(g)}"></option>`)
    .join("");

  if (groupFilterValue !== "*" && !groups.includes(groupFilterValue)) groupFilterValue = "*";
  const options = [`<option value="*">全部分组</option>`].concat(
    groups.map((g, i) => {
      const label = g || RemarkStore.UNGROUPED;
      return `<option value="${i}" ${g === groupFilterValue ? "selected" : ""}>${UI.escapeHtml(label)}</option>`;
    })
  );
  const select = $("group-filter");
  select.innerHTML = options.join("");
  select.onchange = () => {
    groupFilterValue = select.value === "*" ? "*" : groups[Number(select.value)];
    renderList();
  };
}

function renderList() {
  const query = $("search").value.trim().toLowerCase();
  const byGroup = new Map();
  for (const [user, entry] of Object.entries(remarks)) {
    if (groupFilterValue !== "*" && entry.group !== groupFilterValue) continue;
    const haystack = `${user} ${entry.remark} ${entry.group}`.toLowerCase();
    if (query && !haystack.includes(query)) continue;
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push([user, entry]);
  }

  const list = $("list");
  if (!byGroup.size) {
    list.innerHTML = `<p class="empty">${Object.keys(remarks).length ? "没有匹配的备注" : "还没有备注。在 X 上双击用户名即可添加。"}</p>`;
    return;
  }

  list.innerHTML = RemarkStore.sortGroups([...byGroup.keys()])
    .map((group) => {
      const items = byGroup
        .get(group)
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
        .map(
          ([user, entry]) => `
            <div class="item">
              <div class="item-main">
                <a class="user" href="https://x.com/${user}" target="_blank">@${user}</a>
                <span class="remark">${UI.escapeHtml(entry.remark)}</span>
                ${entry.source ? `<span class="source">来自「${UI.escapeHtml(entry.source.title)}」</span>` : ""}
              </div>
              <div class="item-actions">
                <button type="button" class="mini" data-edit="${user}">编辑</button>
                <button type="button" class="mini danger" data-delete="${user}">删除</button>
              </div>
            </div>`
        )
        .join("");
      return `
        <div class="group">
          <div class="group-title">${UI.escapeHtml(group || RemarkStore.UNGROUPED)} <span>${byGroup.get(group).length}</span></div>
          ${items}
        </div>`;
    })
    .join("");
}

async function reloadRemarks() {
  remarks = await RemarkStore.getAll();
  renderGroupControls();
  renderList();
}

$("create-btn").addEventListener("click", (e) =>
  busy(e.target, "创建中…", async () => {
    await Market.createAccount();
    setStatus("账号已创建。请及时「导出账号」保存，丢失将无法找回。");
    await renderAccount();
  })
);

$("import-btn").addEventListener("click", () => $("import-file").click());
$("import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    await Market.importAccount(await file.text());
    setStatus("账号已导入");
    await renderAccount();
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("export-btn").addEventListener("click", async () => {
  const wallet = await Market.getWallet();
  const address = await Market.getAddress();
  if (!wallet) return;
  UI.downloadJson(`x-remark-account-${address.slice(0, 8)}.json`, wallet);
  setStatus("账号文件已下载，请妥善保管，切勿发给他人");
});

$("address").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText(e.target.dataset.full);
  setStatus("地址已复制");
});

$("backup-btn").addEventListener("click", (e) =>
  busy(e.target, "上传中…", async () => {
    const info = await Market.uploadBackup();
    setStatus(`已免费上传 ${info.count} 条备注（加密保存，仅你可读）`);
    await renderAccount();
  })
);

$("restore-btn").addEventListener("click", (e) =>
  busy(e.target, "恢复中…", async () => {
    const result = await Market.restoreBackup();
    setStatus(`已从 ${UI.formatTime(result.at)} 的备份恢复 ${result.count} 条备注`);
    await reloadRemarks();
  })
);

document.querySelectorAll("[data-open]").forEach((btn) => {
  btn.addEventListener("click", () => openMarket(btn.dataset.open));
});

$("remark-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const username = RemarkStore.normalizeUsername($("username").value);
    remarks = await RemarkStore.set(username, $("remark").value, $("group").value);
    $("username").value = "";
    $("remark").value = "";
    $("group").value = "";
    setStatus(`已保存 @${username}`);
    renderGroupControls();
    renderList();
  } catch (err) {
    setStatus(err.message, true);
  }
});

$("search").addEventListener("input", renderList);

$("list").addEventListener("click", async (e) => {
  const editUser = e.target.dataset.edit;
  const deleteUser = e.target.dataset.delete;
  if (editUser) {
    const entry = remarks[editUser];
    $("username").value = editUser;
    $("remark").value = entry.remark;
    $("group").value = entry.group;
    $("remark").focus();
  }
  if (deleteUser) {
    remarks = await RemarkStore.remove(deleteUser);
    setStatus(`已删除 @${deleteUser}`);
    renderGroupControls();
    renderList();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[RemarkStore.KEY]) reloadRemarks();
});

chrome.action.setBadgeText({ text: "" });
renderAccount();
reloadRemarks();
