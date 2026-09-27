// 公文白話通 — 公文搜尋 API（Vercel Serverless）
// AI 聯網搜尋政府最新公文與法規，整理答案與出處
// 環境變數：LLM_API_KEY（必填，Groq 免費申請）、LLM_ENDPOINT（預設 Groq）、MODEL_NAME（預設 gemini-2.0-flash）

export const config = { runtime: 'edge' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const ALLOWED_CATS = ['all','law','gazette','immigration','health','labor','education','interior'];
const CAT_SITES = {
  law: ['law.moj.gov.tw'],
  gazette: ['gazette.nat.gov.tw'],
  immigration: ['immigration.gov.tw'],
  health: ['nhi.gov.tw'],
  labor: ['mol.gov.tw'],
  education: ['edu.tw'],
  interior: ['moi.gov.tw']
};


// 從 DuckDuckGo HTML 搜尋結果中解析出處
function parseDdgResults(html) {
  const results = [];
  // 解析標題與連結
  const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  const links = [];
  let m;
  while ((m = linkRe.exec(html)) !== null && links.length < 8) {
    let url = m[1].replace(/&amp;/g, '&');
    // DuckDuckGo 會把真實網址包在 uddg 參數中
    const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
    if (uddgMatch) {
      try { url = decodeURIComponent(uddgMatch[1]); } catch (_) {}
    }
    const title = m[2].replace(/<[^>]+>/g, '').trim();
    if (title && url && url.startsWith('http')) {
      links.push({ title, url });
    }
  }
  const snippets = [];
  while ((m = snippetRe.exec(html)) !== null && snippets.length < 8) {
    snippets.push(m[1].replace(/<[^>]+>/g, '').trim());
  }
  for (let i = 0; i < links.length; i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] || ''
    });
  }
  return results.slice(0, 5);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return json({ error: '僅接受 POST 請求' }, 405);
  if (!process.env.LLM_API_KEY) return json({ error: '後端尚未設定 LLM_API_KEY' }, 500);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: '請求格式錯誤' }, 400); }
  const { query, category } = body || {};
  if (!query || typeof query !== 'string' || query.trim().length < 2) return json({ error: '請輸入至少 2 個字的搜尋關鍵字' }, 400);
  const cat = (category && ALLOWED_CATS.includes(category)) ? category : 'all';

  // ===== 第一步：DuckDuckGo 聯網搜尋 =====
  const sites = CAT_SITES[cat] || [];
  const siteFilter = sites.length > 0
    ? ' ' + sites.map(s => 'site:' + s).join(' ')
    : ' site:gov.tw';
  const ddgQuery = query.trim() + siteFilter;

  let sources = [];
  try {
    const ddgRes = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(ddgQuery), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      }
    });
    if (ddgRes.ok) {
      const ddgHtml = await ddgRes.text();
      sources = parseDdgResults(ddgHtml);
    }
  } catch (e) {
    // 搜尋失敗不阻斷，繼續用 LLM 直接回答
    console.error('DDG search failed:', e.message);
  }

  // ===== 第二步：LLM 整理答案 =====
  const endpoint = process.env.LLM_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions';
  const model = process.env.MODEL_NAME || 'qwen/qwen3.8-27b';

  const contextText = sources.length > 0
    ? sources.map((s, i) => `[${i + 1}] ${s.title}\n${s.snippet}\n出處：${s.url}`).join('\n\n')
    : '（沒有找到網路資料，請根據你的知識回答，並明確提醒使用者以政府機關正式公告為準）';

  const sysPrompt = '你是「公文白話通」的 AI 助手，專門幫新住民與跨國青年理解台灣政府政策與法規。' +
    '請根據以下搜尋到的資料，用繁體中文白話文回答使用者的問題。' +
    '重點說明：資格條件、申請期限、費用、申請方式、注意事項。' +
    '如果資料不足或有矛盾，請明確說明，不要編造數字或日期。' +
    '回答控制在 300 字以內，用條列重點，語氣親切但資訊準確。';

  try {
    const llmRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.LLM_API_KEY,
      },
      body: JSON.stringify({
        model: model,
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: '問題：' + query.trim() + '\n\n參考資料：\n' + contextText }
        ]
      })
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => '');
      throw new Error('LLM 回應 ' + llmRes.status + ' ' + errText.slice(0, 200));
    }

    const data = await llmRes.json();
    const answer = data?.choices?.[0]?.message?.content?.trim() || '';

    return json({ ok: true, result: { answer: answer, sources: sources } });
  } catch (e) {
    return json({ error: 'AI 服務暫時無法回應：' + e.message, sources: sources }, 502);
  }
}
