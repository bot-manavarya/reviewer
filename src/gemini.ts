export interface GeminiOptions {
  apiKey: string;
  model: string;
  temperature?: number;
}

interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export async function chatJson(
  opts: GeminiOptions,
  system: string,
  user: string
): Promise<string> {
  const url =
    'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';

  const body = {
    model: opts.model,
    temperature: opts.temperature ?? 0.1,
    response_format: { type: 'json_object' as const },
    messages: [
      { role: 'system' as const, content: system },
      { role: 'user' as const, content: user },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Gemini ${res.status} ${res.statusText}: ${text.slice(0, 500)}`
    );
  }

  let data: OpenAIChatResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned non-JSON response: ${text.slice(0, 300)}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error(
      `Gemini returned no content. Raw: ${JSON.stringify(data).slice(0, 400)}`
    );
  }
  return content;
}
