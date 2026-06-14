#!/usr/bin/env node

/**
 * Bilibili search runner with WBI signing.
 *
 * Usage:
 *   node api-replay-recorder/scripts/run-bilibili-search.mjs \
 *     runs/bilibili-search/operation.recipe.json \
 *     runs/bilibili-search/inputs.json \
 *     runs/bilibili-search
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fetchKeys, signUrl } from "./wbi-sign.mjs";

const [, , recipeFile, inputsFile, runDirArg] = process.argv;

if (!recipeFile || !inputsFile) {
  console.error("Usage: node run-bilibili-search.mjs <recipe.json> <inputs.json> [run-dir]");
  process.exit(2);
}

const recipe = JSON.parse(readFileSync(resolve(recipeFile), "utf8"));
const input = JSON.parse(readFileSync(resolve(inputsFile), "utf8"));
const runDir = resolve(runDirArg || dirname(resolve(recipeFile)));
mkdirSync(runDir, { recursive: true });
mkdirSync(join(runDir, "downloads"), { recursive: true });

const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

function log(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  appendFileSync(join(runDir, "results.jsonl"), line + "\n");
  console.log(`  ${entry.step || "?"}: ${entry.status || "ok"} ${entry.message || ""}`);
}

function stripHtml(str) {
  return (str || "").replace(/<[^>]+>/g, "");
}

async function run() {
  console.log(`\n🔍 Bilibili 搜索: "${input.keyword}"\n`);

  // Step 1: Get WBI keys
  console.log("Step 1/3: 获取 WBI 签名密钥...");
  const keys = await fetchKeys({
    headers: { "User-Agent": USER_AGENT }
  });
  log({ step: "get_wbi_keys", status: 200, message: `img_key=${keys.img_key.slice(0,8)}... sub_key=${keys.sub_key.slice(0,8)}...` });

  // Step 2: Build signed URL and search
  console.log("Step 2/3: 搜索视频 (最多播放排序)...");
  const searchParams = {
    category_id: "",
    search_type: "video",
    page: String(input.page || 1),
    page_size: String(input.pageSize || 42),
    order: "click", // 最多播放
    keyword: input.keyword,
    platform: "pc",
    highlight: "1",
    single_column: "0",
    from_source: "web_search",
    web_location: "1430654"
  };

  const searchUrl = signUrl(
    "https://api.bilibili.com/x/web-interface/wbi/search/type",
    searchParams,
    keys.mixin_key
  );

  const resp = await fetch(searchUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": `https://search.bilibili.com/all?keyword=${encodeURIComponent(input.keyword)}&order=click`,
      "Origin": "https://search.bilibili.com"
    }
  });

  const body = await resp.json();
  log({ step: "search_videos", status: resp.status, message: body.code === 0 ? "OK" : `code=${body.code}` });

  if (body.code !== 0 || !body.data?.result) {
    console.error(`\n❌ 搜索失败: code=${body.code} message=${body.message}`);
    process.exit(1);
  }

  // Step 3: Extract and display results
  console.log("Step 3/3: 分析结果...\n");

  const results = body.data.result
    .filter(item => item.type === "video")
    .map(item => ({
      rank: item.rank || 0,
      title: stripHtml(item.title),
      author: item.author,
      bvid: item.bvid,
      aid: item.aid || item.id,
      play: item.play || item.stat?.view || 0,
      like: item.like || item.stat?.like || 0,
      duration: item.duration,
      url: `https://www.bilibili.com/video/${item.bvid}`
    }))
    .sort((a, b) => b.play - a.play);

  // Save full results
  writeFileSync(join(runDir, "results.json"), JSON.stringify({
    query: input.keyword,
    total: body.data.numResults,
    page: body.data.page,
    pagesize: body.data.pagesize,
    topResult: results[0] || null,
    allResults: results
  }, null, 2));

  log({ step: "extract_results", status: "ok", message: `共 ${results.length} 个视频结果` });

  // Display
  console.log(`📊 搜索 "${input.keyword}" 共 ${body.data.numResults} 个结果\n`);
  console.log("🏆 播放量最高的视频:\n");
  const top = results[0];
  if (top) {
    console.log(`   标题:     ${top.title}`);
    console.log(`   作者:     ${top.author}`);
    console.log(`   播放量:   ${top.play.toLocaleString()}`);
    console.log(`   点赞:     ${top.like.toLocaleString()}`);
    console.log(`   时长:     ${top.duration}`);
    console.log(`   链接:     ${top.url}`);
  }

  // Top 5
  console.log(`\n📋 Top ${Math.min(5, results.length)} 排名:\n`);
  results.slice(0, 5).forEach((v, i) => {
    console.log(`  ${i + 1}. [${v.play.toLocaleString()} 播放] ${v.title}`);
    console.log(`     作者: ${v.author} | 时长: ${v.duration} | ${v.url}`);
    console.log();
  });

  // Save state info
  const state = {
    keyword: input.keyword,
    topBvid: top?.bvid,
    topTitle: top?.title,
    topPlay: top?.play,
    wbiKeys: { img_key: keys.img_key, sub_key: keys.sub_key }
  };
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));

  log({ step: "done", status: "ok", message: `top_result: "${top?.title}" (${top?.play?.toLocaleString()} 播放)` });

  return state;
}

run().catch(err => {
  console.error(`\n❌ 运行失败: ${err.message}`);
  process.exit(1);
});
