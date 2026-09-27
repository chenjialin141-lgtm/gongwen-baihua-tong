/**
 * 公文白話通 — Vercel 後端代理（金鑰安全版）
 *
 * 用途：前端把「公文文字 + 想翻譯的語言」POST 到這裡，
 *       本程式在伺服器端呼叫 LLM（DeepSeek / OpenAI / 任何 OpenAI 相容 API），
 *       再把結構化結果回傳給前端。API 金鑰只存在 Vercel 環境變數，前端永遠看不到。
 *
 * 部署：把本檔案放在專案根目錄的 api/ 資料夾（api/translate.js），
 *       連同 index.html 一起推到 Vercel 即可（Hobby 免費方案即可）。
 *
 * 環境變數（Vercel → Settings → Environment Variables）：
 *   LLM_API_KEY   必填，你的 LLM API 金鑰（例如 DeepSeek 的 sk-…）
 *   LLM_ENDPOINT  選填，預設 Groq 免費端點
 *   MODEL_NAME    選填，預設 qwen/qwen3.8-27b（Groq 免費）
 */

export const config = { runtime: 'edge' };

/* ===== 語言白名單 ===== */
const ALLOWED_LANGS = new Set([
  'zh-TW', 'zh-CN', 'ms-MY', 'id-ID', 'vi-VN', 'th-TH', 'tl-PH', 'my-MM', 'km-KH', 'lo-LA'
]);
const LANG_HINT = {
  'zh-TW': '繁體中文白話文（台灣用語，口語、好懂，不照抄原文）',
  'zh-CN': '簡體中文（白話文，用詞以中國大陸通用為準）',
  'ms-MY': '馬來語（馬來西亞標準語 bahasa Melayu；務必使用馬來西亞用詞，嚴禁印尼語詞彙）',
  'id-ID': '印尼語（Bahasa Indonesia，印尼標準用詞）',
  'vi-VN': '越南語（tiếng Việt，越南標準用詞）',
  'th-TH': '泰語（ภาษาไทย，泰國標準用詞）',
  'tl-PH': '菲律賓語／他加祿語（Tagalog / Filipino）',
  'my-MM': '緬甸語（မြန်မာဘာသာ）',
  'km-KH': '高棉語／柬埔寨語（ភាសាខ្មែរ）',
  'lo-LA': '寮語／老撾語（ພາສາລາວ）'
};
const MAX_TEXT_LEN = 30000;   // 與前端 textarea 上限一致
const MAX_LANGS = 6;          // 單次最多翻譯幾種語言（兼顧速度與輸出長度）

/* ===== 簡易防濫用（盡力而為：Vercel 每個隔離實例各自計數） ===== */
const ipHits = new Map();
function rateLimit(ip) {
  const now = Date.now();
  const arr = (ipHits.get(ip) || []).filter(t => now - t < 60000);
  if (arr.length >= 15) return false;
  arr.push(now);
  ipHits.set(ip, arr);
  return true;
}

/* ===== 回應工具 ===== */
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store'
    }
  });
}

/* ===== 嚴格 JSON 解析（容忍模型把 JSON 包在 ``` 程式碼塊裡） ===== */
function parseJsonStrict(str) {
  try { return JSON.parse(str); } catch (_) { /* 往下試 */ }
  const cleaned = String(str).replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (_) { /* 往下試 */ }
  const m = String(str).match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_) { /* 真的解析不了 */ }
  }
  return null;
}

/* ===== 系統提示詞（品質核心，可在這裡自行調整） ===== */
function buildSystemPrompt() {
  return `你是「公文白話通」的翻譯引擎，專門協助台灣新住民與跨國青年看懂台灣政府公文與法規。

請閱讀使用者貼上的公文，然後完成：
1. 判斷這份文件的類型（例如：居留證申請／延期、健保加保、工作許可、補助申請、子女就學、租屋補貼等），用繁體中文簡短命名，例如「居留／簽證」。
2. 針對使用者要求的【每一種】語言，各輸出一個完整、獨立的區塊，包含五個欄位：
   - translation：把整份公文翻譯成該語言的白話文。語氣親切、清楚，像朋友解釋給你聽；不要官腔、不要逐字照翻，但所有重點（資格、期限、文件、方式）都要涵蓋。
   - keyInfo：{deadline: 辦理期限（沒有就寫「無明確期限」）, agency: 負責單位, fee: 費用（沒有就寫「未提及」）, contact: 聯絡方式}，一律使用該語言的文字。
   - documents：需要準備的文件清單，3–5 項，每項 {name, reason}，reason 用一句話說明為什麼需要（該語言文字）。
   - steps：下一步該怎麼做，3–5 步，每步 {title, detail}，寫清楚去哪裡辦、帶什麼、大概多久（該語言文字）。
   - warnings：注意事項 1–3 條，提醒容易搞錯或漏掉的地方（該語言文字）。
3. 每一種語言都要完整、獨立、品質一致，不要因為語言多就偷工。

嚴格遵守語言地區規範：馬來語用馬來西亞標準用詞、不用印尼語；其他語言同理使用該國標準用詞。

只輸出一個 JSON 物件，不要輸出任何其他文字、不要用 markdown 程式碼塊包住。格式如下：
{
  "documentType": "文件類型（繁體中文）",
  "blocks": {
    "zh-TW": {
      "translation": "繁體中文白話翻譯全文",
      "keyInfo": {"deadline": "…", "agency": "…", "fee": "…", "contact": "…"},
      "documents": [{"name": "…", "reason": "…"}],
      "steps": [{"title": "…", "detail": "…"}],
      "warnings": ["…"]
    },
    "vi-VN": {
      "translation": "越南語翻譯全文",
      "keyInfo": {"deadline": "…", "agency": "…", "fee": "…", "contact": "…"},
      "documents": [{"name": "…", "reason": "…"}],
      "steps": [{"title": "…", "detail": "…"}],
      "warnings": ["…"]
    }
  }
}`;
}

/* ===== 主處理器 ===== */
export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }});
  }
  if (req.method !== 'POST') return json({ error: '僅接受 POST 請求' }, 405);

  // 防濫用：每 IP 每分鐘最多 15 次
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!rateLimit(ip)) return json({ error: '請求太頻繁了，請一分鐘後再試' }, 429);

  let body;
  try { body = await req.json(); }
  catch (_) { return json({ error: '請求格式錯誤，請確認送出的是 JSON' }, 400); }

  const text = typeof body.text === 'string' ? body.text.trim() : '';
  let langs = Array.isArray(body.langs)
    ? body.langs.filter(l => typeof l === 'string' && ALLOWED_LANGS.has(l))
    : [];
  langs = [...new Set(langs)]; // 去重

  if (!text || text.length < 10) return json({ error: '請貼上公文內容（至少 10 個字）' }, 400);
  if (text.length > MAX_TEXT_LEN) return json({ error: `公文太長了，請控制在 ${MAX_TEXT_LEN} 字以內` }, 400);
  if (langs.length === 0) return json({ error: '請至少選擇一種語言' }, 400);
  if (langs.length > MAX_LANGS) return json({ error: `一次最多翻譯 ${MAX_LANGS} 種語言，請分批選擇` }, 400);

  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return json({ error: '後端尚未設定 LLM_API_KEY：請到 Vercel 後台 → Settings → Environment Variables 新增' }, 500);
  const endpoint = (process.env.LLM_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions').replace(/\/+$/, '');
  const model = process.env.MODEL_NAME || 'qwen/qwen3.8-27b';

  const langList = langs.map(l => `${l}：${LANG_HINT[l]}`).join('\n');
  const messages = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: `【公文內容】\n${text}\n\n【需要的語言】\n${langList}` }
  ];

  // 第一次嘗試：要求 JSON 模式（多數服務支援）；若被拒絕則自動重試不帶 JSON 模式
  const attempts = [
    { response_format: { type: 'json_object' }, max_tokens: 8000 },
    { max_tokens: 8000 }
  ];

  let lastErr = null;
  for (let i = 0; i < attempts.length; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          ...attempts[i],
          messages
        }),
        signal: ctrl.signal
      });

      if (!res.ok) {
        let detail = '';
        try { const e = await res.json(); detail = e?.error?.message || ''; } catch (_) {}
        // 400 且疑似不支援 response_format 或 max_tokens 太大 → 換參數重試
        if (res.status === 400 && i === 0 && /response_format|max_tokens|parameter/i.test(detail)) {
          lastErr = new Error(detail || '400');
          continue;
        }
        throw new Error(`LLM 服務回應錯誤（${res.status}）：${detail || '請檢查金鑰與模型名稱'}`);
      }

      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content) throw new Error('LLM 沒有回傳內容，請再試一次');

      const parsed = parseJsonStrict(content);
      if (!parsed || !parsed.blocks || typeof parsed.blocks !== 'object') {
        throw new Error('LLM 回傳格式無法解析，請稍後再試或改用其他模型');
      }
      return json({ ok: true, result: parsed });
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        return json({ error: 'AI 服務回應逾時（45 秒），請減少語言數量或縮短公文再試' }, 504);
      }
      lastErr = err;
      // 若是第一次嘗試失敗且錯誤疑似參數問題，繼續迴圈重試；其餘直接回報
      if (i === 0 && err.message.includes('400') && /response_format|max_tokens|parameter/i.test(err.message)) {
        continue;
      }
      return json({ error: err.message || '伺服器錯誤' }, 502);
    } finally {
      clearTimeout(timer);
    }
  }
  return json({ error: `AI 服務呼叫失敗：${lastErr?.message || '未知錯誤'}` }, 502);
}
