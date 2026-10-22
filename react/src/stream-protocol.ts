export type StreamPayload = string | { type: string; [key: string]: unknown };

export interface ParsedStreamPayload {
  done: boolean;
  value?: StreamPayload;
}

/** Parses both the 3.12 legacy JSON envelope and the MCP/v1 event protocol. */
export function parseStreamPayload(data: string): ParsedStreamPayload {
  if (data === '[DONE]' || data === 'end_of_stream') return { done: true };

  let value: unknown;
  try { value = JSON.parse(data); }
  catch { return { done: false, value: data }; }

  if (typeof value === 'string') return { done: false, value };
  if (!value || typeof value !== 'object') return { done: false };

  const frame = value as Record<string, unknown>;
  if (frame['done'] === true) return { done: true };
  if (typeof frame['t'] === 'string') return { done: false, value: frame['t'] };
  if (typeof frame['type'] === 'string') return { done: false, value: frame as StreamPayload };
  return { done: false };
}
