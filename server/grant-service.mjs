#!/usr/bin/env node
// X 备注市场 · 自动发货服务
// 用法：
//   node grant-service.mjs init   生成发货钱包（只需一次），输出需要填入插件的公钥
//   node grant-service.mjs        常驻运行，每分钟检查一次新订单并自动发货
//   node grant-service.mjs once   只检查一次（适合 cron 定时任务）
//   node grant-service.mjs run 4  连续运行 4 分钟，每分钟检查一次（GitHub Actions 使用）
// 发货钱包默认读取同目录的 escrow-wallet.json，也可以通过环境变量 ESCROW_WALLET 传入 JSON。

import { readFile, writeFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webCrypto = globalThis.crypto ?? webcrypto;
const subtle = webCrypto.subtle;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  APP_NAME: process.env.APP_NAME || "X-Remark-Market",
  APP_VERSION: "3",
  ADMIN_ADDRESS: "g85LUi_wJLM8NazTuZcI4VMuFrFLimyqCFJU_7rbP3E",
  ADMIN_FEE_PERCENT: 30n,
  UPLOAD_URL: "https://upload.ardrive.io/v1/tx",
  GATEWAYS: ["https://arweave.net", "https://turbo-gateway.com"],
  WALLET_FILE: process.env.ESCROW_WALLET_FILE || path.join(HERE, "escrow-wallet.json"),
  INTERVAL_MS: Number(process.env.INTERVAL_MS) || 60000,
  MAX_PAGES: 5
};

const JWK_FIELDS = ["kty", "n", "e", "d", "p", "q", "dp", "dq", "qi"];
const encoder = new TextEncoder();
const utf8 = (text) => encoder.encode(text);
const b64e = (bytes) => Buffer.from(bytes).toString("base64url");
const b64d = (text) => new Uint8Array(Buffer.from(text, "base64url"));
const log = (...args) => console.log(new Date().toISOString(), ...args);

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const sha = async (alg, data) => new Uint8Array(await subtle.digest(alg, data));

// ---------- keys ----------

function cleanJwk(jwk) {
  const out = {};
  for (const field of JWK_FIELDS) out[field] = jwk[field];
  return out;
}

async function generateWallet() {
  const pair = await subtle.generateKey(
    { name: "RSA-PSS", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign"]
  );
  return cleanJwk(await subtle.exportKey("jwk", pair.privateKey));
}

const addressOf = async (n) => b64e(await sha("SHA-256", b64d(n)));

async function rsaDecrypt(jwk, bytes) {
  const key = await subtle.importKey("jwk", { ...cleanJwk(jwk), ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
    "decrypt"
  ]);
  return new Uint8Array(await subtle.decrypt({ name: "RSA-OAEP" }, key, bytes));
}

async function rsaEncrypt(n, bytes) {
  const key = await subtle.importKey("jwk", { kty: "RSA", n, e: "AQAB", ext: true }, { name: "RSA-OAEP", hash: "SHA-256" }, false, [
    "encrypt"
  ]);
  return new Uint8Array(await subtle.encrypt({ name: "RSA-OAEP" }, key, bytes));
}

async function signPss(jwk, data) {
  const key = await subtle.importKey("jwk", { ...cleanJwk(jwk), ext: true }, { name: "RSA-PSS", hash: "SHA-256" }, false, [
    "sign"
  ]);
  return new Uint8Array(await subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, data));
}

// ---------- ANS-104 upload ----------

async function deepHash(data) {
  if (Array.isArray(data)) {
    let acc = await sha("SHA-384", concat(utf8("list"), utf8(String(data.length))));
    for (const chunk of data) acc = await sha("SHA-384", concat(acc, await deepHash(chunk)));
    return acc;
  }
  const tagHash = await sha("SHA-384", concat(utf8("blob"), utf8(String(data.byteLength))));
  return sha("SHA-384", concat(tagHash, await sha("SHA-384", data)));
}

function avroLong(n) {
  let zigzag = n * 2;
  const bytes = [];
  while (zigzag >= 0x80) {
    bytes.push((zigzag % 0x80) | 0x80);
    zigzag = Math.floor(zigzag / 0x80);
  }
  bytes.push(zigzag);
  return Uint8Array.from(bytes);
}

function serializeTags(tags) {
  if (!tags.length) return new Uint8Array(0);
  const parts = [avroLong(tags.length)];
  for (const { name, value } of tags) {
    const nameBytes = utf8(name);
    const valueBytes = utf8(value);
    parts.push(avroLong(nameBytes.length), nameBytes, avroLong(valueBytes.length), valueBytes);
  }
  parts.push(new Uint8Array([0]));
  return concat(...parts);
}

function u64le(n) {
  const out = new Uint8Array(8);
  let value = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

async function upload(jwk, data, tags) {
  const owner = b64d(jwk.n);
  const anchor = webCrypto.getRandomValues(new Uint8Array(32));
  const tagBytes = serializeTags(tags);
  const signature = await signPss(
    jwk,
    await deepHash([utf8("dataitem"), utf8("1"), utf8("1"), owner, new Uint8Array(0), anchor, tagBytes, data])
  );
  const bytes = concat(
    new Uint8Array([1, 0]),
    signature,
    owner,
    new Uint8Array([0, 1]),
    anchor,
    u64le(tags.length),
    u64le(tagBytes.length),
    tagBytes,
    data
  );
  const res = await fetch(CONFIG.UPLOAD_URL, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes
  });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  return b64e(await sha("SHA-256", signature));
}

function itemTags(type, extra) {
  const tags = [
    { name: "App-Name", value: CONFIG.APP_NAME },
    { name: "App-Version", value: CONFIG.APP_VERSION },
    { name: "Type", value: type },
    { name: "Content-Type", value: "application/json" },
    { name: "Created-At", value: String(Date.now()) }
  ];
  for (const [name, value] of Object.entries(extra)) tags.push({ name, value: String(value) });
  return tags;
}

// ---------- gateway ----------

const QUERY = `query($ids:[ID!],$owners:[String!],$recipients:[String!],$tags:[TagFilter!],$after:String){
  transactions(ids:$ids, owners:$owners, recipients:$recipients, tags:$tags, first:100, after:$after, sort:HEIGHT_DESC){
    pageInfo { hasNextPage }
    edges { cursor node {
      id recipient
      owner { address key }
      quantity { winston }
      tags { name value }
      block { height }
    } }
  }
}`;

async function queryGateway(gateway, variables) {
  const nodes = [];
  let after = null;
  for (let page = 0; page < CONFIG.MAX_PAGES; page++) {
    const res = await fetch(`${gateway}/graphql`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { ...variables, after } }),
      signal: AbortSignal.timeout(30000)
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const connection = json.data.transactions;
    for (const edge of connection.edges) nodes.push(edge.node);
    if (!connection.pageInfo.hasNextPage || !connection.edges.length) break;
    after = connection.edges[connection.edges.length - 1].cursor;
  }
  return nodes;
}

async function findAll(variables) {
  const results = await Promise.allSettled(CONFIG.GATEWAYS.map((g) => queryGateway(g, variables)));
  if (results.every((r) => r.status === "rejected")) throw results[0].reason;
  const byId = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const node of result.value) {
      const existing = byId.get(node.id);
      if (!existing || (!existing.block && node.block)) byId.set(node.id, node);
    }
  }
  return [...byId.values()];
}

async function fetchJson(id) {
  for (const gateway of CONFIG.GATEWAYS) {
    try {
      const res = await fetch(`${gateway}/${id}`, { signal: AbortSignal.timeout(30000) });
      if (res.ok) return JSON.parse(await res.text());
    } catch {
      // try next gateway
    }
  }
  return null;
}

const filter = (name, value) => ({ name, values: [value] });
const appFilter = filter("App-Name", CONFIG.APP_NAME);

function tagsOf(node) {
  const out = {};
  for (const tag of node.tags || []) out[tag.name] = tag.value;
  return out;
}

// ---------- delivery ----------

const PENDING = "pending";
const INVALID = "invalid";
const DONE = "done";

async function deliver(wallet, feeTx) {
  const tags = tagsOf(feeTx);
  const purchaseId = tags["Purchase-Id"];
  const listingId = tags["Listing-Id"];
  const versionId = tags["Version-Id"];
  const buyer = feeTx.owner.address;
  if (!purchaseId || !listingId || !versionId) return { status: INVALID, reason: "缺少订单标签" };
  if (!feeTx.block) return { status: PENDING, reason: "平台费未确认" };

  const [listing] = await findAll({ ids: [listingId] });
  if (!listing) return { status: PENDING, reason: "备注组尚未被索引" };
  const listingTags = tagsOf(listing);
  if (listingTags["App-Name"] !== CONFIG.APP_NAME || listingTags.Type !== "Listing" || listingTags["Version-Id"] !== versionId) {
    return { status: INVALID, reason: "备注组信息不匹配" };
  }

  const creator = listing.owner.address;
  const price = BigInt(listingTags["Price-Winston"] || "0");
  const fee = (price * CONFIG.ADMIN_FEE_PERCENT) / 100n;
  const creatorPart = price - fee;
  if (price <= 0n || BigInt(feeTx.quantity.winston) < fee) return { status: INVALID, reason: "平台费金额不足" };

  const payments = await findAll({
    owners: [buyer],
    recipients: [creator],
    tags: [appFilter, filter("Type", "Purchase"), filter("Purchase-Id", purchaseId)]
  });
  const paid = payments.find((p) => BigInt(p.quantity.winston) >= creatorPart);
  if (!paid) return { status: PENDING, reason: "创作者款项未到账" };
  if (!paid.block) return { status: PENDING, reason: "创作者款项未确认" };

  const sealed = await fetchJson(listingId);
  if (!sealed) return { status: PENDING, reason: "备注组数据暂不可读" };
  if (!sealed.ek) return { status: INVALID, reason: "该备注组未开启平台自动发货" };

  const key = await rsaDecrypt(wallet, b64d(sealed.ek));
  const k = b64e(await rsaEncrypt(feeTx.owner.key, key));
  const grantId = await upload(
    wallet,
    utf8(JSON.stringify({ v: 3, k })),
    itemTags("Grant", {
      "Purchase-Id": purchaseId,
      "Version-Id": versionId,
      "Listing-Id": listingId,
      Buyer: buyer
    })
  );
  return { status: DONE, grantId, buyer, creator };
}

const settled = new Map();

async function runOnce(wallet, escrow) {
  const [fees, grants] = await Promise.all([
    findAll({ recipients: [CONFIG.ADMIN_ADDRESS], tags: [appFilter, filter("Type", "Fee")] }),
    findAll({ owners: [escrow], tags: [appFilter, filter("Type", "Grant")] })
  ]);
  const granted = new Set(grants.map((g) => tagsOf(g)["Purchase-Id"]));
  let delivered = 0;
  for (const feeTx of fees) {
    const purchaseId = tagsOf(feeTx)["Purchase-Id"];
    if (!purchaseId || granted.has(purchaseId) || settled.has(feeTx.id)) continue;
    try {
      const result = await deliver(wallet, feeTx);
      if (result.status === DONE) {
        granted.add(purchaseId);
        settled.set(feeTx.id, DONE);
        delivered += 1;
        log(`已发货 订单 ${purchaseId} → 买家 ${result.buyer}（授权 ${result.grantId}）`);
      } else if (result.status === INVALID) {
        settled.set(feeTx.id, INVALID);
        log(`跳过 订单 ${purchaseId}：${result.reason}`);
      }
    } catch (err) {
      log(`订单 ${purchaseId} 处理失败，稍后重试：${err.message}`);
    }
  }
  return delivered;
}

async function loadWallet() {
  const text = process.env.ESCROW_WALLET || (await readFile(CONFIG.WALLET_FILE, "utf8"));
  const wallet = JSON.parse(text);
  if (!JWK_FIELDS.every((f) => typeof wallet[f] === "string")) throw new Error("发货钱包格式无效");
  return wallet;
}

async function main() {
  const mode = process.argv[2] || "loop";

  if (mode === "init") {
    const existing = await readFile(CONFIG.WALLET_FILE, "utf8").catch(() => null);
    const wallet = existing ? JSON.parse(existing) : await generateWallet();
    if (!existing) await writeFile(CONFIG.WALLET_FILE, JSON.stringify(wallet), { mode: 0o600 });
    console.log(existing ? "发货钱包已存在：" : "已生成发货钱包：", CONFIG.WALLET_FILE);
    console.log(`ESCROW_ADDRESS: "${await addressOf(wallet.n)}",`);
    console.log(`ESCROW_N: "${wallet.n}",`);
    return;
  }

  const wallet = await loadWallet();
  const escrow = await addressOf(wallet.n);
  log(`自动发货服务启动，发货地址 ${escrow}，市场 ${CONFIG.APP_NAME}`);

  if (mode === "once") {
    log(`本次发货 ${await runOnce(wallet, escrow)} 单`);
    return;
  }

  const minutes = mode === "run" ? Number(process.argv[3]) || 4 : Infinity;
  const deadline = Date.now() + minutes * 60000;
  for (;;) {
    try {
      const delivered = await runOnce(wallet, escrow);
      if (delivered || mode === "run") log(`本轮发货 ${delivered} 单`);
    } catch (err) {
      log(`检查订单失败，稍后重试：${err.message}`);
    }
    if (Date.now() + CONFIG.INTERVAL_MS > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, CONFIG.INTERVAL_MS));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { deliver, runOnce, upload, itemTags, addressOf, rsaEncrypt, rsaDecrypt, generateWallet, findAll, CONFIG };
