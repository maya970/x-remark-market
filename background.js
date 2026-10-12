importScripts("shared/config.js", "shared/store.js", "shared/chain.js", "shared/market.js");

const JOBS_ALARM = "market-jobs";
const LEGACY_KEYS = ["x_sync_meta", "x_login_mode", "x_wander_address", "x_wander_tab_id"];
let jobsRunning = null;

function ensureAlarm() {
  chrome.alarms.create(JOBS_ALARM, { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "add-x-remark",
      title: "为该 X 用户添加备注",
      contexts: ["link"],
      documentUrlPatterns: ["https://x.com/*", "https://twitter.com/*"]
    });
  });
  chrome.storage.local.remove(LEGACY_KEYS);
  ensureAlarm();
});

chrome.runtime.onStartup.addListener(ensureAlarm);

function runJobs() {
  if (!jobsRunning) {
    jobsRunning = Market.runBackgroundJobs()
      .then(async (result) => {
        if (result.claimed > 0) {
          await chrome.action.setBadgeBackgroundColor({ color: "#1d9bf0" });
          await chrome.action.setBadgeText({ text: "新" });
        }
        return result;
      })
      .catch((err) => {
        console.warn("[X 人员标注] 后台任务失败", err);
        return { granted: 0, claimed: 0 };
      })
      .finally(() => {
        jobsRunning = null;
      });
  }
  return jobsRunning;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === JOBS_ALARM) runJobs();
});

async function marketState() {
  const [address, purchases] = await Promise.all([Market.getAddress(), Market.getPurchases()]);
  const owned = Object.values(purchases).map(({ creator, versionId, status }) => ({ creator, versionId, status }));
  return { address, owned };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "RUN_JOBS") {
    runJobs().then(sendResponse);
    return true;
  }
  if (message.type === "MARKET_STATE") {
    marketState().then(sendResponse, () => sendResponse({ address: "", owned: [] }));
    return true;
  }
  if (message.type === "OPEN_PAGE" && /^(purchases|creator|bid|buy=[\w-]{43})$/.test(message.hash)) {
    chrome.tabs.create({ url: chrome.runtime.getURL(`market.html#${message.hash}`) });
  }
  return false;
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "add-x-remark" || !tab?.id) return;
  try {
    const url = new URL(info.linkUrl);
    const [first, second] = url.pathname.split("/").filter(Boolean);
    if (!first || second) return;
    const username = RemarkStore.normalizeUsername(first);
    if (RemarkStore.isValidUsername(username)) {
      chrome.tabs.sendMessage(tab.id, { type: "PROMPT_REMARK", username }).catch(() => {});
    }
  } catch {
    // ignore non-profile links
  }
});
