const { verifySessionToken, getCookie } = require('./_shared/auth');
const { SYSTEM_PROMPT } = require('./_shared/systemPrompt');

const MODEL = 'claude-sonnet-5';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const sessionToken = getCookie(event.headers.cookie, 'session');
  if (!verifySessionToken(sessionToken)) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
  }

  let messages;
  try {
    ({ messages } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'messages must be a non-empty array' }) };
  }

  let anthropicResponse;
  try {
    anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages,
      }),
    });
  } catch {
    return { statusCode: 502, body: JSON.stringify({ error: 'Failed to reach Claude API' }) };
  }

  const data = await anthropicResponse.json();

  if (!anthropicResponse.ok) {
    return {
      statusCode: anthropicResponse.status,
      body: JSON.stringify({ error: data?.error?.message || 'Claude API error' }),
    };
  }

  const textBlock = (data.content || []).find((block) => block.type === 'text');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'assistant', content: textBlock ? textBlock.text : '' }),
  };
};
