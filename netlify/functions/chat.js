const { createClient } = require('@supabase/supabase-js');

const PLAN_LIMITS = { free: 5, pro: 500, premium: 999999 };

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    // 1. Auth check
    const auth = event.headers['authorization'] || '';
    if (!auth.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Please login to continue' }) };
    }

    const token    = auth.split(' ')[1];
    const supabase = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data: { user }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired. Please login again.' }) };
    }

    // 2. Get plan & usage
    const { data: userData } = await supabase.from('users').select('plan').eq('id', user.id).single();
    const plan  = userData?.plan || 'free';
    const limit = PLAN_LIMITS[plan] || 5;
    const today = new Date().toISOString().split('T')[0];

    let { data: usage } = await supabase.from('usage_tracking').select('*').eq('user_id', user.id).single();
    let count = 0;
    if (usage) count = usage.last_reset_date !== today ? 0 : (usage.daily_message_count || 0);

    // 3. Check limit
    if (plan !== 'premium' && count >= limit) {
      return {
        statusCode: 429, headers,
        body: JSON.stringify({ error: 'limit_reached', message: `Daily limit of ${limit} messages reached!` }),
      };
    }

    // 4. Parse request
    const { messages, system, hasImage } = JSON.parse(event.body);
    const GROQ_API_KEY = process.env.GROQ_API_KEY;
    if (!GROQ_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: 'AI not configured' }) };

    // 5. Choose model — vision model for images, fast model for text
    const model = hasImage
      ? 'meta-llama/llama-4-scout-17b-16e-instruct'
      : 'llama-3.3-70b-versatile';

    const groqMessages = [
      { role: 'system', content: system || 'You are NexusAI, a helpful AI assistant.' },
      ...messages.slice(-10).map(m => ({
        role: m.role,
        content: Array.isArray(m.content) ? m.content : m.content,
      })),
    ];

    // 6. Call Groq API
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model,
        messages:    groqMessages,
        max_tokens:  1500,
        temperature: 0.7,
      }),
    });

    const data = await res.json();
    if (data.error) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: data.error.message || 'AI error' }) };
    }

    const reply = data.choices?.[0]?.message?.content;
    if (!reply) return { statusCode: 500, headers, body: JSON.stringify({ error: 'No response from AI' }) };

    // 7. Update usage
    await supabase.from('usage_tracking').upsert({
      user_id:             user.id,
      daily_message_count: count + 1,
      total_messages:      (usage?.total_messages || 0) + 1,
      last_reset_date:     today,
    }, { onConflict: 'user_id' });

    return {
      statusCode: 200, headers,
      body: JSON.stringify({
        reply,
        usage: { used: count+1, limit, remaining: Math.max(0, limit-count-1), plan },
      }),
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error. Please try again.' }) };
  }
};
