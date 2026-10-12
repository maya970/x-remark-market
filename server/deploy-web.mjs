#!/usr/bin/env node
// 把 web/index.html 免费发布到 Arweave，输出新的市场网址（需填入 shared/config.js 的 MARKET_URL）
// 用法：node deploy-web.mjs

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { upload, CONFIG } from "./grant-service.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(HERE, "../web/index.html"));
if (html.byteLength > 100 * 1024) throw new Error("网页超过 100KB 免费上限");

const wallet = JSON.parse(process.env.ESCROW_WALLET || (await readFile(CONFIG.WALLET_FILE, "utf8")));
const id = await upload(wallet, new Uint8Array(html), [
  { name: "Content-Type", value: "text/html; charset=utf-8" },
  { name: "App-Name", value: "X-Remark-Market-Web" },
  { name: "Title", value: "X 备注市场" }
]);
console.log(`已发布：https://turbo-gateway.com/${id}`);
console.log(`（打包上链后 https://arweave.net/${id} 也可访问）`);
