/**
 * Groq chat client.
 *
 * A thin wrapper over Groq's OpenAI-compatible chat completions endpoint. It
 * knows nothing about Asana: the caller supplies tools and messages, this
 * returns the model's reply. Keeping it provider-shaped rather than
 * Asana-shaped means the assistant could be pointed at another provider by
 * replacing this file alone.
 *
 * The API key never leaves the server. The browser talks to /api/ai, and this
 * module is the only thing that holds a credential.
 */

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export interface ChatToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

export interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly content: string;
  readonly tool_calls?: readonly ChatToolCall[];
  readonly tool_call_id?: string;
  readonly name?: string;
}

export interface ChatTool {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export interface ChatResult {
  readonly content: string;
  readonly toolCalls: readonly ChatToolCall[];
}

export class GroqError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GroqError';
  }
}

export interface GroqOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs?: number;
}

export async function chat(
  options: GroqOptions,
  messages: readonly ChatMessage[],
  tools: readonly ChatTool[],
): Promise<ChatResult> {
  // A hung provider must not hold an Express connection open indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);

  let response: Response;
  try {
    response = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        ...(tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
        // Low but not zero: the assistant should be predictable about which
        // action it picks, while still writing readable prose.
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new GroqError(
      aborted ? 'The assistant timed out.' : 'The assistant provider is unreachable.',
      aborted ? 504 : 502,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    // The provider's own message can echo request content, so it is summarised
    // rather than forwarded verbatim.
    const detail = response.status === 401 ? 'The assistant credential was rejected.' : '';
    throw new GroqError(
      `The assistant provider returned ${response.status}. ${detail}`.trim(),
      response.status === 429 ? 429 : 502,
    );
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: ChatToolCall[] } }>;
  };

  const message = payload.choices?.[0]?.message;

  return {
    content: message?.content ?? '',
    toolCalls: message?.tool_calls ?? [],
  };
}
