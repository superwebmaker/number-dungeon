/**
 * Cloudflare Pages Functions Middleware
 * Injects environment variables into HTML responses for client-side access
 */
export async function onRequest(context) {
    const response = await context.next();
    const contentType = response.headers.get('content-type') || '';

    // Only process HTML responses
    if (!contentType.includes('text/html')) {
        return response;
    }

    const html = await response.text();

    // Build runtime config from Cloudflare environment variables
    const runtimeConfig = {
        GEMINI_API_KEY: context.env.GEMINI_API_KEY || '',
        THIRD_PARTY_API_KEY: context.env.THIRD_PARTY_API_KEY || '',
        THIRD_PARTY_API_URL: context.env.THIRD_PARTY_API_URL || '',
        THIRD_PARTY_MODEL: context.env.THIRD_PARTY_MODEL || '',
    };

    // Inject script before </head>
    const injectedScript = `<script>window.__ENV__=${JSON.stringify(runtimeConfig)};</script>`;
    const modifiedHtml = html.replace('</head>', `${injectedScript}</head>`);

    return new Response(modifiedHtml, {
        status: response.status,
        headers: response.headers,
    });
}
