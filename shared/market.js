const Market = (() => {
  const K = CONFIG.KEYS;
  const APP_FILTER = { name: "App-Name", values: [CONFIG.APP_NAME] };
  const ESCROW_GRACE_MS = 30 * 60 * 1000;
  const filter = (name, value) => ({ name, values: [value] });

  const DEFAULT_CREATOR = {
    title: "",
    description: "",
    price: "",
    groups: null,
    current: null,
    versions: {},
    granted: [],
    bids: [],
    sales: 0,
    earnedWinston: "0"
  };

  async function load(key, fallback) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? fallback;
  }

  async function save(key, value) {
    await chrome.storage.local.set({ [key]: value });
    return value;
  }

  function itemTags(type, extra = {}) {
    const tags = [
      { name: "App-Name", value: CONFIG.APP_NAME },
      { name: "App-Version", value: CONFIG.APP_VERSION },
      { name: "Type", value: type },
      { name: "Content-Type", value: "application/json" },
      { name: "Created-At", value: String(Date.now()) }
    ];
    for (const [name, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && String(value) !== "") {
        tags.push({ name, value: String(value) });
      }
    }
    return tags;
  }

  function tagsOf(node) {
    const out = {};
    for (const tag of node.tags || []) out[tag.name] = tag.value;
    return out;
  }

  function encodeJson(value) {
    return Chain.utf8(JSON.stringify(value));
  }

  // ---------- account ----------

  function getWallet() {
    return load(K.WALLET, null);
  }

  async function requireWallet() {
    const wallet = await getWallet();
    if (!wallet) throw new Error("请先在扩展弹窗中创建或导入账号");
    return wallet;
  }

  async function getAddress() {
    const wallet = await getWallet();
    return wallet ? Chain.addressOf(wallet.n) : "";
  }

  async function createAccount() {
    const wallet = await Chain.generateWallet();
    await save(K.WALLET, wallet);
    return Chain.addressOf(wallet.n);
  }

  async function importAccount(text) {
    let wallet;
    try {
      wallet = JSON.parse(text);
    } catch {
      throw new Error("账号文件格式无效");
    }
    if (!Chain.isValidJwk(wallet)) throw new Error("不是有效的 Arweave 账号文件");
    await save(K.WALLET, Chain.cleanJwk(wallet));
    return Chain.addressOf(wallet.n);
  }

  async function getBalance() {
    const address = await getAddress();
    return address ? Chain.getBalance(address) : 0n;
  }

  // ---------- encryption ----------

  async function sealFor(ownerN, payload) {
    const key = Chain.randomKey();
    const box = await Chain.aesEncrypt(key, await Chain.gzip(encodeJson(payload)));
    const k = Chain.b64urlEncode(await Chain.rsaEncrypt(ownerN, key));
    return { key, sealed: { v: 3, z: 1, iv: box.iv, ct: box.ct, k } };
  }

  async function openWithKey(key, sealed) {
    const plain = await Chain.aesDecrypt(key, sealed);
    const bytes = sealed.z ? await Chain.gunzip(plain) : plain;
    return JSON.parse(Chain.utf8Decode(bytes));
  }

  async function uploadSealed(wallet, sealed, tags) {
    const whole = encodeJson(sealed);
    if (whole.byteLength <= CONFIG.MAX_ITEM_BYTES) return Chain.upload(wallet, whole, tags);
    const size = CONFIG.MAX_ITEM_BYTES - 2048;
    const chunks = [];
    for (let i = 0; i < sealed.ct.length; i += size) chunks.push(sealed.ct.slice(i, i + size));
    const parts = [];
    for (const chunk of chunks.slice(1)) {
      parts.push(await Chain.upload(wallet, encodeJson({ ct: chunk }), itemTags("Part")));
    }
    return Chain.upload(wallet, encodeJson({ ...sealed, ct: chunks[0], parts }), tags);
  }

  async function fetchSealed(id) {
    const main = await Chain.fetchJson(id);
    if (!Array.isArray(main.parts) || !main.parts.length) return main;
    const rest = await Promise.all(main.parts.map((partId) => Chain.fetchJson(partId)));
    return { ...main, ct: main.ct + rest.map((part) => part.ct).join("") };
  }

  async function openSealed(wallet, sealed) {
    const key = await Chain.rsaDecrypt(wallet, Chain.b64urlDecode(sealed.k));
    return { key, payload: await openWithKey(key, sealed) };
  }

  // ---------- personal backup (free) ----------

  function getBackupInfo() {
    return load(K.BACKUP, null);
  }

  async function uploadBackup() {
    const wallet = await requireWallet();
    const remarks = await RemarkStore.getAll();
    const count = Object.keys(remarks).length;
    if (!count) throw new Error("还没有备注可以上传");
    const { sealed } = await sealFor(wallet.n, { remarks });
    const id = await uploadSealed(wallet, sealed, itemTags("Backup"));
    return save(K.BACKUP, { id, at: Date.now(), count });
  }

  async function restoreBackup() {
    const wallet = await requireWallet();
    const me = await Chain.addressOf(wallet.n);
    const local = await getBackupInfo();
    let best = local?.id ? { id: local.id, at: local.at } : null;
    try {
      const nodes = await Chain.findTxs({
        owners: [me],
        tags: [APP_FILTER, filter("Type", "Backup")],
        first: 20
      });
      for (const node of nodes) {
        const at = Number(tagsOf(node)["Created-At"]) || 0;
        if (!best || at > best.at) best = { id: node.id, at };
      }
    } catch (err) {
      if (!best) throw err;
    }
    if (!best) throw new Error("没有找到云端备份");
    const { payload } = await openSealed(wallet, await fetchSealed(best.id));
    const merged = RemarkStore.mergeNewer(await RemarkStore.getAll(), payload.remarks);
    await RemarkStore.saveAll(merged);
    return { count: Object.keys(payload.remarks || {}).length, at: best.at };
  }

  // ---------- creator program ----------

  async function getCreator() {
    return { ...DEFAULT_CREATOR, ...(await load(K.CREATOR, {})) };
  }

  async function updateCreator(mutate) {
    const creator = await getCreator();
    mutate(creator);
    return save(K.CREATOR, creator);
  }

  function sellableRemarks(all, groups) {
    const wanted = new Set(groups);
    const out = {};
    for (const [user, entry] of Object.entries(all)) {
      if (entry.source || !wanted.has(entry.group)) continue;
      out[user] = { remark: entry.remark, group: entry.group, updatedAt: entry.updatedAt };
    }
    return out;
  }

  async function publishListing({ title, description, price, groups }) {
    const wallet = await requireWallet();
    title = String(title || "").trim().slice(0, 40);
    description = String(description || "").trim().slice(0, 500);
    if (!title) throw new Error("请填写标题");
    const priceWinston = Chain.arToWinston(price);
    if (priceWinston < CONFIG.MIN_PRICE_WINSTON) throw new Error("价格至少 0.001 AR");
    if (!groups?.length) throw new Error("请至少选择一个分组");

    const remarks = sellableRemarks(await RemarkStore.getAll(), groups);
    const count = Object.keys(remarks).length;
    if (!count) throw new Error("所选分组中没有你自己写的备注");

    const versionId = crypto.randomUUID();
    const { key, sealed } = await sealFor(wallet.n, { remarks });
    sealed.ek = Chain.b64urlEncode(await Chain.rsaEncrypt(CONFIG.ESCROW_N, key));
    const groupNames = [...new Set(Object.values(remarks).map((e) => e.group || RemarkStore.UNGROUPED))];
    const preview = Object.entries(remarks)
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 8)
      .map(([user]) => user);
    const id = await uploadSealed(
      wallet,
      sealed,
      itemTags("Listing", {
        "Version-Id": versionId,
        Status: "active",
        Title: title,
        Description: description,
        "Price-Winston": priceWinston.toString(),
        "Entry-Count": count,
        Groups: groupNames.join(",").slice(0, 300),
        Preview: preview.join(",")
      })
    );

    const version = {
      id,
      key: Chain.b64urlEncode(key),
      priceWinston: priceWinston.toString(),
      title,
      count,
      createdAt: Date.now()
    };
    await updateCreator((creator) => {
      creator.versions[versionId] = version;
      Object.assign(creator, { title, description, price: String(price).trim(), groups, current: versionId });
    });
    return version;
  }

  async function closeListing() {
    const wallet = await requireWallet();
    await Chain.upload(
      wallet,
      encodeJson({ v: 3, closed: true }),
      itemTags("Listing", { "Version-Id": `closed-${crypto.randomUUID()}`, Status: "closed" })
    );
    await updateCreator((creator) => {
      creator.current = null;
    });
  }

  async function fetchListings() {
    const nodes = await Chain.findTxs({ tags: [APP_FILTER, filter("Type", "Listing")], first: 100 });
    const latest = new Map();
    for (const node of nodes) {
      const tags = tagsOf(node);
      const creator = node.owner.address;
      const createdAt = Number(tags["Created-At"]) || 0;
      const previous = latest.get(creator);
      if (previous && previous.createdAt >= createdAt) continue;
      let priceWinston = 0n;
      try {
        priceWinston = BigInt(tags["Price-Winston"] || "0");
      } catch {
        priceWinston = 0n;
      }
      latest.set(creator, {
        id: node.id,
        creator,
        versionId: tags["Version-Id"] || "",
        status: tags.Status,
        title: tags.Title || "未命名",
        description: tags.Description || "",
        priceWinston: priceWinston.toString(),
        priceAr: Chain.winstonToAr(priceWinston),
        count: Number(tags["Entry-Count"]) || 0,
        groups: (tags.Groups || "").split(",").filter(Boolean),
        preview: (tags.Preview || "").split(",").filter(Boolean),
        createdAt
      });
    }
    return [...latest.values()]
      .filter((l) => l.status === "active" && BigInt(l.priceWinston) > 0n)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async function resolveVersion(wallet, me, creator, versionId) {
    if (creator.versions[versionId]) return creator.versions[versionId];
    const nodes = await Chain.findTxs({
      owners: [me],
      tags: [APP_FILTER, filter("Type", "Listing"), filter("Version-Id", versionId)],
      first: 1
    });
    if (!nodes.length) return null;
    const tags = tagsOf(nodes[0]);
    const sealed = await Chain.fetchJson(nodes[0].id);
    const key = await Chain.rsaDecrypt(wallet, Chain.b64urlDecode(sealed.k));
    const version = {
      id: nodes[0].id,
      key: Chain.b64urlEncode(key),
      priceWinston: tags["Price-Winston"] || "0",
      title: tags.Title || "",
      count: Number(tags["Entry-Count"]) || 0,
      createdAt: Number(tags["Created-At"]) || 0
    };
    creator.versions[versionId] = version;
    return version;
  }

  async function processSales(wallet) {
    const me = await Chain.addressOf(wallet.n);
    const sales = await Chain.findTxs({
      recipients: [me],
      tags: [APP_FILTER, filter("Type", "Purchase")],
      first: 100
    });
    if (!sales.length) return 0;

    const creator = await getCreator();
    const alreadyGranted = new Set(creator.granted);
    const newlyGranted = [];
    let earned = 0n;
    let granted = 0;

    for (const sale of sales) {
      const tags = tagsOf(sale);
      const purchaseId = tags["Purchase-Id"];
      const versionId = tags["Version-Id"];
      if (!sale.block || !purchaseId || !versionId || alreadyGranted.has(purchaseId)) continue;
      try {
        const version = await resolveVersion(wallet, me, creator, versionId);
        if (!version) continue;
        const { fee, creatorPart } = Chain.splitPrice(BigInt(version.priceWinston));
        const paid = BigInt(sale.quantity?.winston || "0");
        if (paid < creatorPart) continue;

        const buyer = sale.owner.address;
        const fees = await Chain.findTxs({
          owners: [buyer],
          recipients: [CONFIG.ADMIN_ADDRESS],
          tags: [APP_FILTER, filter("Type", "Fee"), filter("Purchase-Id", purchaseId)],
          first: 5
        });
        if (!fees.some((f) => f.block && BigInt(f.quantity?.winston || "0") >= fee)) continue;

        const existing = await Chain.findTxs({
          owners: [me, CONFIG.ESCROW_ADDRESS],
          tags: [APP_FILTER, filter("Type", "Grant"), filter("Purchase-Id", purchaseId)],
          first: 1
        });
        if (!existing.length) {
          const confirmedAt = (sale.block.timestamp || 0) * 1000;
          if (Date.now() - confirmedAt < ESCROW_GRACE_MS) continue;
          const k = Chain.b64urlEncode(
            await Chain.rsaEncrypt(sale.owner.key, Chain.b64urlDecode(version.key))
          );
          await Chain.upload(
            wallet,
            encodeJson({ v: 3, k }),
            itemTags("Grant", {
              "Purchase-Id": purchaseId,
              "Version-Id": versionId,
              "Listing-Id": version.id,
              Buyer: buyer
            })
          );
          granted += 1;
        }
        alreadyGranted.add(purchaseId);
        newlyGranted.push(purchaseId);
        earned += paid;
      } catch (err) {
        console.warn("[X 人员标注] 授权失败", purchaseId, err);
      }
    }

    await updateCreator((fresh) => {
      fresh.versions = { ...creator.versions, ...fresh.versions };
      fresh.granted = [...new Set([...fresh.granted, ...newlyGranted])].slice(-5000);
      fresh.sales += newlyGranted.length;
      fresh.earnedWinston = (BigInt(fresh.earnedWinston) + earned).toString();
    });
    return granted;
  }

  // ---------- bidding ----------

  async function fetchBids() {
    const nodes = await Chain.findTxs({
      recipients: [CONFIG.ADMIN_ADDRESS],
      tags: [APP_FILTER, filter("Type", "Bid")],
      first: 100
    });
    const since = Date.now() - CONFIG.BID_DAYS * 86400000;
    const totals = new Map();
    for (const node of nodes) {
      const at = node.block ? node.block.timestamp * 1000 : Date.now();
      if (at < since) continue;
      const creator = node.owner.address;
      totals.set(creator, (totals.get(creator) || 0n) + BigInt(node.quantity?.winston || "0"));
    }
    return [...totals]
      .map(([creator, winston]) => ({ creator, winston }))
      .sort((a, b) => (b.winston > a.winston ? 1 : b.winston < a.winston ? -1 : 0));
  }

  async function placeBid(amountAr) {
    const wallet = await requireWallet();
    const creator = await getCreator();
    const current = creator.current ? creator.versions[creator.current] : null;
    if (!current) throw new Error("请先发布你的备注，再参与竞价");
    const amount = Chain.arToWinston(amountAr);
    if (amount < CONFIG.MIN_BID_WINSTON) {
      throw new Error(`单次出价至少 ${Chain.winstonToAr(CONFIG.MIN_BID_WINSTON)} AR`);
    }
    const tx = await Chain.signTransfer(wallet, CONFIG.ADMIN_ADDRESS, amount, {
      "App-Name": CONFIG.APP_NAME,
      "App-Version": CONFIG.APP_VERSION,
      Type: "Bid",
      "Listing-Id": current.id
    });
    const needed = amount + BigInt(tx.reward);
    const balance = await Chain.getBalance(await Chain.addressOf(wallet.n));
    if (balance < needed) {
      throw new Error(
        `余额不足：本次约需 ${Chain.winstonToAr(needed)} AR（含网络费），当前 ${Chain.winstonToAr(balance)} AR`
      );
    }
    await Chain.postTx(tx);
    await updateCreator((fresh) => {
      fresh.bids = [...(fresh.bids || []), { txId: tx.id, winston: amount.toString(), at: Date.now() }].slice(-50);
    });
    return tx.id;
  }

  // ---------- buying ----------

  function getPurchases() {
    return load(K.PURCHASES, {});
  }

  async function savePurchase(record) {
    const all = await getPurchases();
    all[record.purchaseId] = record;
    await save(K.PURCHASES, all);
    return record;
  }

  async function postPayments(record, wallet) {
    for (const transfer of record.transfers) {
      if (transfer.posted) continue;
      try {
        await Chain.postTx(transfer.signed);
      } catch (err) {
        if (err.status !== 400 || !wallet || !Chain.canSignTransfers()) {
          record.error = err.message;
          await savePurchase(record);
          throw err;
        }
        transfer.signed = await Chain.signTransfer(
          wallet,
          transfer.target,
          BigInt(transfer.winston),
          transfer.tags
        );
        await Chain.postTx(transfer.signed);
      }
      transfer.posted = true;
      transfer.txId = transfer.signed.id;
      await savePurchase(record);
    }
    for (const transfer of record.transfers) delete transfer.signed;
    delete record.error;
    record.status = "waiting";
    record.paidAt = Date.now();
    return savePurchase(record);
  }

  async function buy(listing) {
    const wallet = await requireWallet();
    const me = await Chain.addressOf(wallet.n);
    if (me === listing.creator) throw new Error("这是你自己发布的备注");

    const existing = Object.values(await getPurchases()).find(
      (p) => p.creator === listing.creator && p.versionId === listing.versionId
    );
    if (existing) {
      throw new Error(existing.status === "done" ? "已购买该版本，可免费重新同步" : "该版本已付款，正在等待授权");
    }

    const price = BigInt(listing.priceWinston);
    const { fee, creatorPart } = Chain.splitPrice(price);
    const purchaseId = crypto.randomUUID();
    const common = {
      "App-Name": CONFIG.APP_NAME,
      "App-Version": CONFIG.APP_VERSION,
      "Purchase-Id": purchaseId,
      "Version-Id": listing.versionId,
      "Listing-Id": listing.id
    };
    const transfers = [
      { target: listing.creator, winston: creatorPart.toString(), tags: { ...common, Type: "Purchase" } },
      { target: CONFIG.ADMIN_ADDRESS, winston: fee.toString(), tags: { ...common, Type: "Fee" } }
    ];
    for (const transfer of transfers) {
      transfer.signed = await Chain.signTransfer(wallet, transfer.target, BigInt(transfer.winston), transfer.tags);
    }

    const needed = transfers.reduce((sum, t) => sum + BigInt(t.winston) + BigInt(t.signed.reward), 0n);
    const balance = await Chain.getBalance(me);
    if (balance < needed) {
      throw new Error(
        `余额不足：本次约需 ${Chain.winstonToAr(needed)} AR（含网络费），当前 ${Chain.winstonToAr(balance)} AR`
      );
    }

    const record = {
      purchaseId,
      creator: listing.creator,
      versionId: listing.versionId,
      listingId: listing.id,
      title: listing.title,
      count: listing.count,
      priceWinston: listing.priceWinston,
      createdAt: Date.now(),
      status: "paying",
      transfers
    };
    await savePurchase(record);
    return postPayments(record, wallet);
  }

  async function retryPurchase(purchaseId) {
    const wallet = await requireWallet();
    const record = (await getPurchases())[purchaseId];
    if (!record || record.status !== "paying") return record;
    return postPayments(record, wallet);
  }

  async function applyPurchase(wallet, purchase, grantId) {
    const grant = await Chain.fetchJson(grantId);
    const key = await Chain.rsaDecrypt(wallet, Chain.b64urlDecode(grant.k));
    const payload = await openWithKey(key, await fetchSealed(purchase.listingId));
    const { remarks, added } = RemarkStore.mergePurchased(await RemarkStore.getAll(), payload.remarks, {
      creator: purchase.creator,
      title: purchase.title
    });
    await RemarkStore.saveAll(remarks);
    const all = await getPurchases();
    Object.assign(all[purchase.purchaseId], { status: "done", grantId, syncedAt: Date.now(), added });
    await save(K.PURCHASES, all);
    return { added };
  }

  async function resync(purchaseId) {
    const wallet = await requireWallet();
    const purchase = (await getPurchases())[purchaseId];
    if (!purchase?.grantId) throw new Error("该购买尚未获得授权");
    return applyPurchase(wallet, purchase, purchase.grantId);
  }

  async function claimGrants(wallet) {
    const me = await Chain.addressOf(wallet.n);
    const waiting = Object.values(await getPurchases()).filter((p) => p.status === "waiting");
    let claimed = 0;
    for (const purchase of waiting) {
      try {
        const grants = await Chain.findTxs({
          owners: [CONFIG.ESCROW_ADDRESS, purchase.creator],
          tags: [
            APP_FILTER,
            filter("Type", "Grant"),
            filter("Purchase-Id", purchase.purchaseId),
            filter("Buyer", me)
          ],
          first: 5
        });
        for (const grant of grants) {
          try {
            await applyPurchase(wallet, purchase, grant.id);
            claimed += 1;
            break;
          } catch (err) {
            console.warn("[X 人员标注] 授权无法使用，尝试下一个", grant.id, err);
          }
        }
      } catch (err) {
        console.warn("[X 人员标注] 同步购买失败", purchase.purchaseId, err);
      }
    }
    return claimed;
  }

  async function retryPendingPayments(wallet) {
    const pending = Object.values(await getPurchases()).filter((p) => p.status === "paying");
    for (const record of pending) {
      await postPayments(record, wallet).catch(() => {});
    }
  }

  async function runBackgroundJobs() {
    const wallet = await getWallet();
    if (!wallet || !Chain.isOnline()) return { granted: 0, claimed: 0 };
    await retryPendingPayments(wallet);
    const granted = await processSales(wallet).catch((err) => {
      console.warn("[X 人员标注] 检查销售失败", err);
      return 0;
    });
    const claimed = await claimGrants(wallet).catch((err) => {
      console.warn("[X 人员标注] 检查授权失败", err);
      return 0;
    });
    return { granted, claimed };
  }

  return {
    getWallet,
    getAddress,
    createAccount,
    importAccount,
    getBalance,
    getBackupInfo,
    uploadBackup,
    restoreBackup,
    getCreator,
    publishListing,
    closeListing,
    fetchListings,
    fetchBids,
    placeBid,
    getPurchases,
    buy,
    retryPurchase,
    resync,
    runBackgroundJobs
  };
})();
