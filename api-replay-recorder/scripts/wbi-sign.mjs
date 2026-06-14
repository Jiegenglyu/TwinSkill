// Bilibili WBI signing implementation
// Reference: https://socialsisteryi.github.io/bilibili-API-collect/docs/misc/sign/wbi.html

import { createHash } from "node:crypto";

const MIXIN_KEY_ENC_TABLE = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 37, 12, 44, 56, 7,
  0, 57, 39, 60, 16, 1, 40, 51, 54, 59, 17, 13, 25, 52, 24, 55,
  38, 41, 4, 36, 6, 22, 11, 61, 48, 34, 26, 62, 21, 20, 63
];

function getMixinKey(key) {
  let mixin = "";
  for (let i = 0; i < MIXIN_KEY_ENC_TABLE.length && i < key.length; i++) {
    mixin += key[MIXIN_KEY_ENC_TABLE[i]];
  }
  return mixin.slice(0, 32);
}

function extractKeyFromUrl(url) {
  // URL format: https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png
  const match = url?.match(/\/([a-f0-9]{32})\.(png|jpg|webp)/i);
  return match ? match[1] : null;
}

/**
 * Get WBI signing keys from the nav endpoint or passed image URLs.
 * @param {object} wbiImg - { img_url, sub_url } from nav API
 * @returns {{ img_key: string, sub_key: string, mixin_key: string }}
 */
export function getKeys(wbiImg) {
  const imgKey = extractKeyFromUrl(wbiImg?.img_url);
  const subKey = extractKeyFromUrl(wbiImg?.sub_url);
  if (!imgKey || !subKey) {
    throw new Error(`Cannot extract WBI keys from: ${JSON.stringify(wbiImg)}`);
  }
  const mixinKey = getMixinKey(imgKey + subKey);
  return { img_key: imgKey, sub_key: subKey, mixin_key: mixinKey };
}

/**
 * Fetch WBI keys from the Bilibili nav endpoint.
 * @param {object} [fetchOptions] - Additional fetch options (headers, etc.)
 * @returns {Promise<{ img_key: string, sub_key: string, mixin_key: string }>}
 */
export async function fetchKeys(fetchOptions = {}) {
  const resp = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      ...fetchOptions.headers
    },
    ...fetchOptions
  });
  const body = await resp.json();
  if (!body.data?.wbi_img?.img_url || !body.data?.wbi_img?.sub_url) {
    throw new Error(`Failed to get WBI keys: ${JSON.stringify(body)}`);
  }
  return getKeys(body.data.wbi_img);
}

/**
 * Sign parameters with WBI.
 * @param {Record<string, string>} params - Query parameters
 * @param {string} mixinKey - The WBI mixin key
 * @returns {{ w_rid: string, wts: string }}
 */
export function sign(params, mixinKey) {
  const wts = Math.floor(Date.now() / 1000).toString();
  const sorted = Object.fromEntries(
    Object.entries({ ...params, wts })
      .filter(([k]) => k !== "w_rid" && k !== "wts")
      .sort(([a], [b]) => a.localeCompare(b))
  );
  const query = new URLSearchParams(sorted).toString();
  const w_rid = createHash("md5").update(query + mixinKey).digest("hex");
  return { w_rid, wts };
}

/**
 * Build a fully signed URL for a WBI-protected endpoint.
 * @param {string} baseUrl - The API endpoint URL (without query string)
 * @param {Record<string, string>} params - Query parameters
 * @param {string} mixinKey - The WBI mixin key
 * @returns {string} - The full signed URL
 */
export function signUrl(baseUrl, params, mixinKey) {
  const { w_rid, wts } = sign(params, mixinKey);
  const allParams = new URLSearchParams({ ...params, w_rid, wts });
  return `${baseUrl}?${allParams.toString()}`;
}
