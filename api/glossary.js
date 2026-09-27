// 公文白話通 — 詞彙 AI 查詞 API（Vercel Edge Function）
// 輸入一個公文詞彙，AI 回傳白話解釋、例句與 9 語翻譯
// 環境變數：LLM_API_KEY（必填，Groq 免費申請）、LLM_ENDPOINT（預設 Groq）、MODEL_NAME（預設 qwen/qwen3.8-27b）

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

// LLM 回傳的語言代碼對照到前端使用的完整代碼
const KEY_MAP = {
  'zh-CN': 'zh-CN', 'zh': 'zh-CN',
  'ms': 'ms-MY', 'ms-MY': 'ms-MY',
  'id': 'id-ID', 'id-ID': 'id-ID',
  'vi': 'vi-VN', 'vi-VN': 'vi-VN',
  'th': 'th-TH', 'th-TH': 'th-TH',
  'tl': 'tl-PH', 'tl-PH': 'tl-PH',
  'my': 'my-MM', 'my-MM': 'my-MM',
  'km': 'km-KH', 'km-KH': 'km-KH',
  'lo': 'lo-LA', 'lo-LA': 'lo-LA'
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (req.method !== 'POST') return json({ error: '僅接受 POST 請求' }, 405);
  if (!process.env.LLM_API_KEY) return json({ error: '後端尚未設定 LLM_API_KEY' }, 500);

  let body;
  try { body = await req.json(); } catch (_) { return json({ error: '請求格式錯誤' }, 400); }

  const term = body.term;
  if (!term || typeof term !== 'string' || term.trim().length < 1) {
    return json({ error: '請輸入要查的詞' }, 400);
  }
  const cleanTerm = term.trim().slice(0, 50);

  const endpoint = process.env.LLM_ENDPOINT || 'https://api.groq.com/openai/v1/chat/completions';
  const model = process.env.MODEL_NAME || 'qwen/qwen3.8-27b';

  const sysPrompt = '你是「公文白話通」的詞彙助手，專門幫新住民與跨國青年理解台灣政府公文用語。' +
    '請解釋使用者輸入的詞彙，用繁體中文白話文。' +
    '輸出嚴格 JSON 格式，不要有任何其他文字、標籤或說明：' +
    '{"plain":"白話解釋（30字內，口語易懂）","example":"一個真實公文場景的例句（含這個詞）",' +
    '"translations":{"zh-CN":"簡體中文","ms":"馬來語","id":"印尼語","vi":"越南語","th":"泰語",' +
    '"tl":"菲律賓語","my":"緬甸語","km":"高棉語","lo":"寮國語"}}' +
    '如果這個詞不是公文常用詞，也請照實解釋，不要編造。';

  try {
    const llmRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + process.env.LLM_API_KEY
      },
      body: JSON.stringify({
        model: model,
        temperature: 0.3,
        max_tokens: 500,
        messages: [
          { role: 'system', content: sysPrompt },
          { role: 'user', content: cleanTerm }
        ]
      })
    });

    if (!llmRes.ok) {
      const errText = await llmRes.text().catch(() => '');
      throw new Error('LLM 回應 ' + llmRes.status + ' ' + errText.slice(0, 200));
    }

    const data = await llmRes.json();
    const content = data?.choices?.[0]?.message?.content?.trim() || '';

    let parsed = {};
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]); } catch (_) {}
    }

    const normTrans = {};
    if (parsed.translations && typeof parsed.translations === 'object') {
      for (const [k, v] of Object.entries(parsed.translations)) {
        const nk = KEY_MAP[k] || k;
        normTrans[nk] = String(v || '').trim();
      }
    }

    return json({
      ok: true,
      result: {
        plain: (parsed.plain || '').trim(),
        example: (parsed.example || '').trim(),
        translations: normTrans
      }
    });
  } catch (e) {
    return json({ error: 'AI 服務暫時無法回應：' + e.message }, 502);
  }
}
