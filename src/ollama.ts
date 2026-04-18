export interface OllamaOptions {
  baseUrl: string;
  model: string;
  temperature?: number;
  numCtx?: number;
}

export async function chatJson(
  opts: OllamaOptions,
  system: string,
  user: string
): Promise<string> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/chat`;
  const body = {
    model: opts.model,
    stream: false,
    format: 'json',
    options: {
      temperature: opts.temperature ?? 0.1,
      num_ctx: opts.numCtx ?? 16384,
    },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status} ${res.statusText}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  const content = data?.message?.content;
  if (!content) throw new Error('Ollama returned no message content');
  return content;
}

export async function ensureModel(opts: OllamaOptions): Promise<void> {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/tags`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ollama /api/tags ${res.status}`);
  const data = (await res.json()) as { models?: Array<{ name: string }> };
  const names = (data.models ?? []).map((m) => m.name);
  if (!names.some((n) => n === opts.model || n.startsWith(opts.model + ':'))) {
    throw new Error(
      `Model "${opts.model}" is not present on the Ollama server. Installed: ${names.join(', ') || '(none)'}. Pull it with: ollama pull ${opts.model}`
    );
  }
}
