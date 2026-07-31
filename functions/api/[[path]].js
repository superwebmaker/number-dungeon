/**
 * 通用 Cloudflare Pages Functions LLM API 网关代理
 *
 * 核心功能：
 * 1. 代理前端发起的 `/api/*` 请求至配置的 `UPSTREAM_API_URL`
 * 2. 自动注入 `UPSTREAM_API_KEY` (Bearer Token)
 * 3. 智能兼容 `/v1` 路径重叠与协议头缺失问题
 * 4. 灵活参数覆盖与多模型别名映射机制：
 *    - 上游地址：前端 Header `X-Upstream-Url` > 环境变量 `UPSTREAM_API_URL`
 *    - API Key：前端 Header `X-Upstream-Key` > 环境变量 `UPSTREAM_API_KEY`
 *    - 模型映射优先级：
 *        ① 前端请求 model 在 `API_MODEL_MAP` (JSON) 中的映射
 *        ② 环境变量 `API_MODEL_<NAME>` (如 API_MODEL_PRO)
 *        ③ 前端请求原样模型
 *        ④ 环境变量 `API_MODEL` 兜底
 * 5. 全功能支持 CORS Preflight 及 SSE 流式响应 (Stream)
 */

export async function onRequest(context) {
  const { request, env, params } = context;
  const origin = request.headers.get('Origin') || '*';

  // 1. 处理 CORS Preflight 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, PATCH',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-Upstream-Url, X-Upstream-Key',
        'Access-Control-Max-Age': '86400',
      },
    });
  }

  // 2. 解析与覆盖上游 URL 和 Key
  const customUpstreamUrl = request.headers.get('X-Upstream-Url');
  const customUpstreamKey = request.headers.get('X-Upstream-Key');

  const upstreamUrl = (customUpstreamUrl && customUpstreamUrl.trim()) || env.UPSTREAM_API_URL;
  const upstreamKey = (customUpstreamKey && customUpstreamKey.trim()) || env.UPSTREAM_API_KEY;

  if (!upstreamUrl || !upstreamKey) {
    return jsonError(
      "Gateway Configuration Error: Missing UPSTREAM_API_URL or UPSTREAM_API_KEY in Cloudflare Pages environment variables.",
      500,
      origin
    );
  }

  // 3. 智能拼接目标上游 URL
  const subPath = params.path ? '/' + params.path.join('/') : '';
  const targetUrl = buildTargetUrl(upstreamUrl, subPath, request.url);

  // 4. 构建代理请求头
  const proxyHeaders = new Headers(request.headers);
  proxyHeaders.set('Authorization', `Bearer ${upstreamKey}`);
  proxyHeaders.delete('Host');
  proxyHeaders.delete('CF-Connecting-IP');
  proxyHeaders.delete('CF-IPCountry');
  proxyHeaders.delete('CF-Ray');
  proxyHeaders.delete('CF-Visitor');
  proxyHeaders.delete('X-Upstream-Url');
  proxyHeaders.delete('X-Upstream-Key');

  // 5. 请求 Body 处理与多模型映射逻辑
  let requestBody = request.body;

  if (
    ['POST', 'PUT', 'PATCH'].includes(request.method) &&
    isJsonContent(request.headers.get('content-type'))
  ) {
    try {
      const rawText = await request.text();
      if (rawText.trim()) {
        const bodyObj = JSON.parse(rawText);
        if (typeof bodyObj === 'object' && bodyObj !== null) {
          const finalModel = resolveModel(bodyObj.model, env);
          if (finalModel) {
            bodyObj.model = finalModel;
          }
          requestBody = JSON.stringify(bodyObj);
          proxyHeaders.set('Content-Type', 'application/json');
        }
      }
    } catch (e) {
      // Body 解析失败时使用原始 body 传输
    }
  }

  // 6. 发送代理请求
  const proxyRequest = new Request(targetUrl.toString(), {
    method: request.method,
    headers: proxyHeaders,
    body: requestBody,
    redirect: 'follow',
  });

  try {
    const response = await fetch(proxyRequest);

    // 7. 返回响应，附加 CORS 标头并保留流式通道 (Response.body)
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', origin);
    responseHeaders.set('Access-Control-Allow-Credentials', 'true');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch (err) {
    return jsonError(`Gateway Proxy Error: ${err.message}`, 502, origin);
  }
}

// --- 辅助工具函数 ---

/**
 * 智能模型解析与映射中心
 */
function resolveModel(incomingModel, env) {
  const modelStr = (incomingModel || '').trim();

  // 1. 尝试从 JSON 映射表 API_MODEL_MAP 中解析
  if (env.API_MODEL_MAP) {
    try {
      const map = typeof env.API_MODEL_MAP === 'string' ? JSON.parse(env.API_MODEL_MAP) : env.API_MODEL_MAP;
      if (modelStr && map[modelStr]) {
        return map[modelStr];
      }
      if ((!modelStr || modelStr === 'default') && map['default']) {
        return map['default'];
      }
    } catch (e) {
      console.error("Failed to parse API_MODEL_MAP:", e);
    }
  }

  // 2. 尝试从动态环境变量查找 (如 model="pro" -> 环境变量 API_MODEL_PRO)
  if (modelStr) {
    const envKey = `API_MODEL_${modelStr.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}`;
    if (env[envKey]) {
      return env[envKey];
    }
  }

  // 3. 兜底使用单模型变量 API_MODEL (当 model 为 default、未填或无特定映射时)
  if (env.API_MODEL && (!modelStr || modelStr === 'default')) {
    return env.API_MODEL;
  }

  // 4. 前端传递了具体模型标识且无特殊映射，直接使用，或再次兜底 env.API_MODEL
  return modelStr || env.API_MODEL || undefined;
}

/**
 * 智能拼接目标 URL，自动规避重复 /v1 前缀与缺失协议头
 */
function buildTargetUrl(baseUrl, subPath, requestUrlStr) {
  let cleanBase = (baseUrl || '').trim().replace(/\/+$/, '');

  // 自动补全 http:// 或 https://
  if (!/^https?:\/\//i.test(cleanBase)) {
    cleanBase = 'https://' + cleanBase;
  }

  let cleanSub = subPath;

  // 处理 /v1 路径重复
  if (cleanBase.endsWith('/v1') && cleanSub.startsWith('/v1')) {
    cleanSub = cleanSub.replace(/^\/v1/, '');
  }

  const fullUrlStr = cleanBase + cleanSub;
  const targetUrl = new URL(fullUrlStr);

  // 保持原有 URL 的 Query 参数 (如 ?stream=true)
  if (requestUrlStr) {
    try {
      const incomingUrl = new URL(requestUrlStr);
      targetUrl.search = incomingUrl.search;
    } catch (e) {}
  }

  return targetUrl;
}

function isJsonContent(contentType) {
  return contentType && contentType.toLowerCase().includes('application/json');
}

function jsonError(message, status, origin = '*') {
  return new Response(
    JSON.stringify({
      error: {
        message,
        type: 'gateway_error',
        status,
      },
    }),
    {
      status,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': origin,
      },
    }
  );
}
