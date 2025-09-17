/**
 * Helper utilities for interacting with the OpenAI Chat Completions API.
 * @module llm
 */

export const DEFAULT_MODEL = 'gpt-4o-mini';
const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

/**
 * Load the API key and model preference from chrome.storage.sync.
 * @returns {Promise<{apiKey: string, model: string}>}
 */
export async function getStoredOpenAIConfig() {
  const stored = await chrome.storage.sync.get({ apiKey: '', model: DEFAULT_MODEL });
  const apiKey = typeof stored.apiKey === 'string' ? stored.apiKey.trim() : '';
  const model = typeof stored.model === 'string' && stored.model.trim() ? stored.model.trim() : DEFAULT_MODEL;
  return { apiKey, model };
}

/**
 * Call the OpenAI Chat Completions API.
 * @param {{ messages: Array<{role: 'system'|'user'|'assistant', content: string}>, model?: string, temperature?: number, signal?: AbortSignal }} params
 * @returns {Promise<any>}
 */
export async function requestChatCompletion(params) {
  const { messages, model: explicitModel, temperature = 0.2, signal } = params;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Missing messages for chat completion request.');
  }

  const { apiKey, model } = await getStoredOpenAIConfig();
  if (!apiKey) {
    throw new Error('OpenAI API key is not set. Please open the extension options and add it.');
  }

  const payload = {
    model: explicitModel || model || DEFAULT_MODEL,
    messages,
    temperature,
    response_format: { type: 'json_object' }
  };

  const response = await fetch(OPENAI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return response.json();
}

/**
 * Parse the primary message content from a chat completion result.
 * @param {any} completion
 * @returns {string}
 */
export function extractMessageContent(completion) {
  const choices = completion && Array.isArray(completion.choices) ? completion.choices : [];
  const choice = choices[0];
  if (!choice) {
    throw new Error('Unexpected OpenAI response format.');
  }
  const message = choice.message ? choice.message : null;
  const content = message && typeof message.content === 'string' ? message.content : undefined;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenAI response did not include content.');
  }
  return content.trim();
}
