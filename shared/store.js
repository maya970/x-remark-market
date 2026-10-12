const RemarkStore = (() => {
  const KEY = CONFIG.KEYS.REMARKS;
  const UNGROUPED = "未分组";

  function normalizeUsername(username) {
    return String(username || "").replace(/^@/, "").trim().toLowerCase();
  }

  function isValidUsername(username) {
    return /^[a-z0-9_]{1,15}$/.test(username);
  }

  function normalizeEntry(value) {
    if (typeof value === "string") value = { remark: value };
    if (!value || typeof value !== "object") return null;
    const remark = String(value.remark || "").trim().slice(0, 40);
    if (!remark) return null;
    const entry = {
      remark,
      group: String(value.group || "").trim().slice(0, 40),
      updatedAt: Number(value.updatedAt) || 0
    };
    if (value.source?.creator) {
      entry.source = {
        creator: String(value.source.creator),
        title: String(value.source.title || "")
      };
    }
    return entry;
  }

  function normalizeAll(raw) {
    const out = {};
    for (const [user, value] of Object.entries(raw || {})) {
      const key = normalizeUsername(user);
      const entry = normalizeEntry(value);
      if (entry && isValidUsername(key)) out[key] = entry;
    }
    return out;
  }

  async function getAll() {
    const result = await chrome.storage.local.get(KEY);
    return normalizeAll(result[KEY]);
  }

  async function saveAll(remarks) {
    const normalized = normalizeAll(remarks);
    await chrome.storage.local.set({ [KEY]: normalized });
    return normalized;
  }

  async function set(username, remark, group) {
    const key = normalizeUsername(username);
    if (!isValidUsername(key)) throw new Error("用户名格式不正确（字母、数字、下划线，最长 15 位）");
    const all = await getAll();
    const text = String(remark || "").trim();
    if (text) {
      all[key] = {
        remark: text.slice(0, 40),
        group: String(group || "").trim().slice(0, 40),
        updatedAt: Date.now()
      };
    } else {
      delete all[key];
    }
    return saveAll(all);
  }

  async function remove(username) {
    const all = await getAll();
    delete all[normalizeUsername(username)];
    return saveAll(all);
  }

  function sortGroups(groups) {
    return groups.sort((a, b) => (a === "") - (b === "") || a.localeCompare(b, "zh-CN"));
  }

  function groupsOf(remarks, { ownOnly = false } = {}) {
    const groups = new Set();
    for (const entry of Object.values(remarks)) {
      if (ownOnly && entry.source) continue;
      groups.add(entry.group);
    }
    return sortGroups([...groups]);
  }

  function mergeNewer(local, incoming) {
    const merged = { ...local };
    for (const [user, entry] of Object.entries(normalizeAll(incoming))) {
      const current = merged[user];
      if (!current || entry.updatedAt > current.updatedAt) merged[user] = entry;
    }
    return merged;
  }

  function mergePurchased(local, incoming, source) {
    const remarks = { ...local };
    let added = 0;
    for (const [user, entry] of Object.entries(normalizeAll(incoming))) {
      const current = remarks[user];
      if (current && !current.source) continue;
      remarks[user] = {
        remark: entry.remark,
        group: `${source.title}/${entry.group || UNGROUPED}`.slice(0, 40),
        updatedAt: Date.now(),
        source
      };
      if (!current) added += 1;
    }
    return { remarks, added };
  }

  return {
    KEY,
    UNGROUPED,
    normalizeUsername,
    isValidUsername,
    normalizeAll,
    getAll,
    saveAll,
    set,
    remove,
    sortGroups,
    groupsOf,
    mergeNewer,
    mergePurchased
  };
})();
