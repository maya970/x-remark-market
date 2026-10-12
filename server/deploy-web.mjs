#!/usr/bin/env node
// 把 web/ 下的网页免费发布到 Arweave，输出网址
// 用法：node deploy-web.mjs              发布市场 web/index.html（新网址需填入 shared/config.js 的 MARKET_URL）
//       node deploy-web.mjs privacy.html 发布隐私权政策

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { upload, CONFIG } from "./grant-service.mjs";

const PAGES = {
  "index.html": { app: "X-Remark-Market-Web", title: "X 备注市场" },
  "privacy.html": { app: "X-Remark-Privacy", title: "X 人员标注 隐私权政策" }
};

const file = process.argv[2] || "index.html";
const page = PAGES[file];
if (!page) throw new Error(`未知页面：${file}（可选：${Object.keys(PAGES).join("、")}）`);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = await readFile(path.join(HERE, "../web", file));
if (html.byteLength > 100 * 1024) throw new Error("网页超过 100KB 免费上限");

const wallet = JSON.parse(process.env.ESCROW_WALLET || (await readFile(CONFIG.WALLET_FILE, "utf8")));
const id = await upload(wallet, new Uint8Array(html), [
  { name: "Content-Type", value: "text/html; charset=utf-8" },
  { name: "App-Name", value: page.app },
  { name: "Title", value: page.title }
]);
console.log(`已发布：https://turbo-gateway.com/${id}`);
console.log(`（打包上链后 https://arweave.net/${id} 也可访问）`);
