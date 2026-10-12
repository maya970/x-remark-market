const Chain = (() => {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const WINSTON_PER_AR = 1000000000000n;
  const JWK_FIELDS = ["kty", "n", "e", "d", "p", "q", "dp", "dq", "qi"];

  const utf8 = (text) => encoder.encode(text);
  const utf8Decode = (bytes) => decoder.decode(bytes);

  function concat(...parts) {
    const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function b64urlEncode(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  function b64urlDecode(text) {
    const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  async function sha(algorithm, data) {
    return new Uint8Array(await crypto.subtle.digest(algorithm, data));
  }

  function arToWinston(ar) {
    const text = String(ar ?? "").trim();
    if (!/^\d+(\.\d{1,12})?$/.test(text)) throw new Error("金额格式不正确，例如 0.5");
    const [whole, fraction = ""] = text.split(".");
    return BigInt(whole) * WINSTON_PER_AR + BigInt(fraction.padEnd(12, "0"));
  }

  function winstonToAr(winston) {
    const value = BigInt(winston);
    const whole = value / WINSTON_PER_AR;
    const fraction = (value % WINSTON_PER_AR).toString().padStart(12, "0").replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : `${whole}`;
  }

  function splitPrice(priceWinston) {
    const fee = (priceWinston * CONFIG.ADMIN_FEE_PERCENT) / 100n;
    return { fee, creatorPart: priceWinston - fee };
  }

  function cleanJwk(jwk) {
    const out = {};
    for (const field of JWK_FIELDS) out[field] = jwk[field];
    return out;
  }

  function isValidJwk(jwk) {
    return Boolean(jwk) && jwk.kty === "RSA" && JWK_FIELDS.every((f) => typeof jwk[f] === "string" && jwk[f]);
  }

  async function generateWallet() {
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSA-PSS",
        modulusLength: 4096,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256"
      },
      true,
      ["sign"]
    );
    return cleanJwk(await crypto.subtle.exportKey("jwk", pair.privateKey));
  }

  async function addressOf(n) {
    return b64urlEncode(await sha("SHA-256", b64urlDecode(n)));
  }

  function importPrivate(jwk, algorithm, usages) {
    return crypto.subtle.importKey("jwk", { ...cleanJwk(jwk), ext: true }, algorithm, false, usages);
  }

  async function signPss(jwk, data) {
    const key = await importPrivate(jwk, { name: "RSA-PSS", hash: "SHA-256" }, ["sign"]);
    return new Uint8Array(await crypto.subtle.sign({ name: "RSA-PSS", saltLength: 32 }, key, data));
  }

  async function rsaEncrypt(n, bytes) {
    const key = await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n, e: "AQAB", ext: true },
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["encrypt"]
    );
    return new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, bytes));
  }

  async function rsaDecrypt(jwk, bytes) {
    const key = await importPrivate(jwk, { name: "RSA-OAEP", hash: "SHA-256" }, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, bytes));
  }

  function randomKey() {
    return crypto.getRandomValues(new Uint8Array(32));
  }

  async function aesEncrypt(rawKey, plain) {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
    return { iv: b64urlEncode(iv), ct: b64urlEncode(ct) };
  }

  async function aesDecrypt(rawKey, box) {
    const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64urlDecode(box.iv) },
      key,
      b64urlDecode(box.ct)
    );
    return new Uint8Array(plain);
  }

  async function pipeThrough(bytes, stream) {
    const piped = new Blob([bytes]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(piped).arrayBuffer());
  }

  const gzip = (bytes) => pipeThrough(bytes, new CompressionStream("gzip"));
  const gunzip = (bytes) => pipeThrough(bytes, new DecompressionStream("gzip"));

  async function deepHash(data) {
    if (Array.isArray(data)) {
      let acc = await sha("SHA-384", concat(utf8("list"), utf8(String(data.length))));
      for (const chunk of data) {
        acc = await sha("SHA-384", concat(acc, await deepHash(chunk)));
      }
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

  async function createDataItem(jwk, data, tags) {
    const owner = b64urlDecode(jwk.n);
    if (owner.length !== 512) throw new Error("仅支持 4096 位 Arweave 账号");
    const anchor = crypto.getRandomValues(new Uint8Array(32));
    const tagBytes = serializeTags(tags);
    const signatureData = await deepHash([
      utf8("dataitem"),
      utf8("1"),
      utf8("1"),
      owner,
      new Uint8Array(0),
      anchor,
      tagBytes,
      data
    ]);
    const signature = await signPss(jwk, signatureData);
    const bytes = concat(
      new Uint8Array([1, 0]),
      signature,
      owner,
      new Uint8Array([0]),
      new Uint8Array([1]),
      anchor,
      u64le(tags.length),
      u64le(tagBytes.length),
      tagBytes,
      data
    );
    return { id: b64urlEncode(await sha("SHA-256", signature)), bytes };
  }

  const OFFLINE_MESSAGE = "当前没有网络，备注仍安全保存在本机，联网后再同步即可";

  function isOnline() {
    return navigator.onLine !== false;
  }

  function ensureOnline() {
    if (!isOnline()) throw new Error(OFFLINE_MESSAGE);
  }

  async function upload(jwk, data, tags) {
    if (data.byteLength > CONFIG.MAX_ITEM_BYTES) {
      throw new Error("单个上传超过 100KB 免费上限");
    }
    ensureOnline();
    const item = await createDataItem(jwk, data, tags);
    const res = await fetch(CONFIG.UPLOAD_URL, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: item.bytes
    }).catch(() => {
      throw new Error(isOnline() ? "无法连接上传服务，请稍后再试" : OFFLINE_MESSAGE);
    });
    if (res.status === 402) throw new Error("该账号的免费上传额度已用完，未产生任何扣费");
    if (!res.ok) throw new Error(`上传失败（HTTP ${res.status}）`);
    const receipt = await res.json().catch(() => ({}));
    return receipt.id || item.id;
  }

  async function gql(query, variables) {
    ensureOnline();
    const results = await Promise.allSettled(
      CONFIG.GATEWAYS.map(async (gateway) => {
        const res = await fetch(`${gateway}/graphql`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query, variables }),
          signal: AbortSignal.timeout(20000)
        });
        if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
        const json = await res.json();
        if (json.errors?.length) throw new Error(json.errors[0].message);
        return json.data?.transactions?.edges || [];
      })
    );
    if (results.every((r) => r.status === "rejected")) {
      throw new Error("无法连接 Arweave 索引服务，请稍后再试");
    }
    const byId = new Map();
    for (const result of results) {
      if (result.status !== "fulfilled") continue;
      for (const { node } of result.value) {
        const existing = byId.get(node.id);
        if (!existing || (!existing.block && node.block)) byId.set(node.id, node);
      }
    }
    return [...byId.values()];
  }

  function findTxs({ owners, recipients, tags, first = 100 }) {
    const query = `query($owners:[String!],$recipients:[String!],$tags:[TagFilter!],$first:Int){
      transactions(owners:$owners, recipients:$recipients, tags:$tags, first:$first, sort:HEIGHT_DESC){
        edges { node {
          id recipient
          owner { address key }
          quantity { winston }
          tags { name value }
          block { height timestamp }
        } }
      }
    }`;
    return gql(query, { owners, recipients, tags, first });
  }

  async function fetchJson(id) {
    ensureOnline();
    for (const gateway of CONFIG.GATEWAYS) {
      try {
        const res = await fetch(`${gateway}/${id}`, { signal: AbortSignal.timeout(20000) });
        if (res.ok) return JSON.parse(await res.text());
      } catch {
        // try next gateway
      }
    }
    throw new Error("数据暂未就绪，请稍后再试");
  }

  async function getBalance(address) {
    ensureOnline();
    const res = await fetch(`https://${CONFIG.ARWEAVE_NODE}/wallet/${address}/balance`);
    if (!res.ok) throw new Error("查询余额失败");
    return BigInt((await res.text()).trim() || "0");
  }

  function canSignTransfers() {
    return typeof Arweave !== "undefined";
  }

  async function signTransfer(jwk, target, winston, tags) {
    if (!canSignTransfers()) throw new Error("付款模块未加载");
    const arweave = Arweave.init({ host: CONFIG.ARWEAVE_NODE, port: 443, protocol: "https" });
    const tx = await arweave.createTransaction({ target, quantity: winston.toString() }, cleanJwk(jwk));
    for (const [name, value] of Object.entries(tags)) tx.addTag(name, String(value));
    await arweave.transactions.sign(tx, cleanJwk(jwk));
    return tx.toJSON();
  }

  async function postTx(tx) {
    ensureOnline();
    const res = await fetch(`https://${CONFIG.ARWEAVE_NODE}/tx`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tx)
    });
    if (res.ok || res.status === 208) return;
    const detail = await res.text().catch(() => "");
    const err = new Error(`付款发送失败（HTTP ${res.status}）${detail ? "：" + detail.slice(0, 80) : ""}`);
    err.status = res.status;
    throw err;
  }

  return {
    utf8,
    utf8Decode,
    b64urlEncode,
    b64urlDecode,
    arToWinston,
    winstonToAr,
    splitPrice,
    cleanJwk,
    isValidJwk,
    generateWallet,
    addressOf,
    rsaEncrypt,
    rsaDecrypt,
    randomKey,
    aesEncrypt,
    aesDecrypt,
    gzip,
    gunzip,
    createDataItem,
    isOnline,
    upload,
    findTxs,
    fetchJson,
    getBalance,
    canSignTransfers,
    signTransfer,
    postTx
  };
})();
