import { parseStreamPayload } from './stream-protocol';

export interface Domain {
  id: number;
  name: string;
  limitedAccess?: boolean;
  createAt?: string;
  lastModifiedDate?: string;
}
export interface Chat {
  id: number;
  name: string;
  domainId: number;
  createAt?: string;
  modifiedAt?: string;
  domain?: { id: number; name: string };
}
export interface ReasoningStep {
  id?: number | string;
  stepIndex?: number;
  kind?: string;
  status?: string;
  labelKey?: string;
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  toolRowCount?: number;
  toolTruncated?: boolean;
  toolErrorText?: string;
  durationMs?: number;
}
export interface Message {
  id: number;
  question?: string;
  response?: string;
  reasoningSteps?: ReasoningStep[];
  artifacts?: unknown[];
}
export interface DomainDocument {
  id: number;
  name: string;
  createAt?: string;
  documentType?: string;
  state?: string;
  sourceType?: string;
  createdBy?: string;
}
export interface MessageSource {
  id?: number;
  sourceType?: string;
  embeding?: string;
  answer?: string;
  documentPage?: string;
  document?: {
    id?: number;
    name?: string;
    documentType?: string;
    documentSize?: number;
    url?: string;
  };
  validatedKnowledge?: { id?: number; question?: string; answer?: string; name?: string };
  [key: string]: unknown;
}
export interface StreamEvent { type: string; [key: string]: unknown; }

export class VekaiApi {
  private token: string | null = null;

  async login(username: string, password: string): Promise<void> {
    const result = await this.request<{ id_token: string }>('/api/authenticate', {
      method: 'POST', body: JSON.stringify({ username, password, rememberMe: false }),
      headers: { 'Content-Type': 'application/json' },
    }, false);
    this.token = result.id_token;
  }

  logout(): void {
    this.token = null;
  }

  listDomains(): Promise<Domain[]> {
    return this.request('/api/domains?page=0&size=100');
  }

  createDomain(name: string): Promise<Domain> {
    return this.request('/api/domains', this.json('POST', {
      name, description: '', instructions: '', lengthyResponse: false,
      llmKnowledge: false, reactRag: false, advancedTables: false,
    }));
  }

  createChat(domainId: number, name: string): Promise<Chat> {
    return this.request(`/api/domains/${domainId}/chat`, this.json('POST', { id: null, name }));
  }

  renameChat(domainId: number, chatId: number, name: string): Promise<void> {
    return this.request(`/api/domains/${domainId}/chat/${chatId}`, this.json('PATCH', { id: chatId, name }));
  }

  async listChats(domainId: number): Promise<Chat[]> {
    const chats = await this.request<Chat[]>(`/api/domains/${domainId}/chat?page=0&size=100&sort=modifiedAt,desc`);
    return chats.map(chat => ({ ...chat, domainId }));
  }

  async listRecentChats(domainIds: number[], limit = 5): Promise<Chat[]> {
    const accessibleDomains = new Set(domainIds);
    const chats = await this.request<Chat[]>('/api/chats?page=0&size=100&sort=modifiedAt,desc');
    return chats
      .map(chat => ({ ...chat, domainId: Number(chat.domainId ?? chat.domain?.id ?? 0) }))
      .filter(chat => chat.domainId > 0 && accessibleDomains.has(chat.domainId))
      .sort((a, b) => this.chatTimestamp(b) - this.chatTimestamp(a))
      .slice(0, limit);
  }

  async uploadDocument(domainId: number, file: File): Promise<DomainDocument> {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'binary';
    const form = new FormData();
    form.append('uploadFile', file, file.name);
    form.append('document', JSON.stringify({
      name: file.name, url: file.name, documentType: extension,
      documentSize: file.size, domain: { id: domainId },
    }));
    return this.request(`/api/domains/${domainId}/documents`, { method: 'POST', body: form });
  }

  listDocuments(domainId: number): Promise<DomainDocument[]> {
    return this.request(`/api/domains/${domainId}/documents?page=0&size=100&sort=createAt,desc`);
  }

  ask(domainId: number, chatId: number, question: string): Promise<Message> {
    return this.request(`/api/domains/${domainId}/chat/${chatId}/messages`,
      this.json('POST', { question, subdomainIds: [] }));
  }

  getSources(domainId: number, chatId: number, messageId: number): Promise<MessageSource[]> {
    return this.request(`/api/domains/${domainId}/chat/${chatId}/messages/${messageId}/source`);
  }

  async viewDocument(domainId: number, documentId: number): Promise<Blob> {
    this.requireToken();
    const response = await fetch(`/api/domains/${domainId}/documents/${documentId}/view`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) throw new Error(`VEKAI respondió ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    return response.blob();
  }

  getMessages(domainId: number, chatId: number): Promise<Message[]> {
    return this.request(
      `/api/domains/${domainId}/chat/${chatId}/messages?page=0&size=100&sort=questionAskedAt,desc`);
  }

  async getMcpSources(domainId: number, chatId: number, messageId: number): Promise<ReasoningStep[]> {
    const messages = await this.getMessages(domainId, chatId);
    return messages.find(message => message.id === messageId)?.reasoningSteps
      ?.filter(step => step.kind === 'tool' && step.toolOutput != null) ?? [];
  }

  async stream(
    domainId: number,
    chatId: number,
    question: string,
    onEvent: (event: StreamEvent | string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    this.requireToken();
    const response = await fetch(
      `/api/domains/${domainId}/chats/${chatId}/messages/stream?question=${encodeURIComponent(question)}`,
      { headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal },
    );
    if (!response.ok || !response.body) throw new Error(`VEKAI respondió ${response.status}: ${await response.text()}`);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      buffer += value ?? '';
      const records = buffer.replace(/\r\n/g, '\n').split('\n\n');
      buffer = records.pop() ?? '';
      for (const record of records) {
        const data = record.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const parsed = parseStreamPayload(data);
        if (parsed.done) return;
        if (parsed.value && typeof parsed.value !== 'string' && parsed.value.type === 'error') {
          throw new Error(String(parsed.value['errorText'] ?? 'Error recibido durante el streaming.'));
        }
        if (parsed.value !== undefined) onEvent(parsed.value as StreamEvent | string);
      }
      if (done) {
        const data = buffer.split('\n').filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart()).join('\n');
        if (data) {
          const parsed = parseStreamPayload(data);
          if (parsed.value && typeof parsed.value !== 'string' && parsed.value.type === 'error') {
            throw new Error(String(parsed.value['errorText'] ?? 'Error recibido durante el streaming.'));
          }
          if (!parsed.done && parsed.value !== undefined) onEvent(parsed.value as StreamEvent | string);
        }
        return;
      }
    }
  }

  private async request<T>(path: string, init: RequestInit = {}, authenticated = true): Promise<T> {
    const headers = new Headers(init.headers);
    if (authenticated) {
      this.requireToken();
      headers.set('Authorization', `Bearer ${this.token}`);
    }
    headers.set('Accept', 'application/json');
    const response = await fetch(path, { ...init, headers });
    if (!response.ok) throw new Error(`VEKAI respondió ${response.status}: ${(await response.text()).slice(0, 1000)}`);
    if (response.status === 204) return undefined as T;
    const body = await response.text();
    return body ? JSON.parse(body) as T : undefined as T;
  }

  private json(method: string, value: unknown): RequestInit {
    return { method, body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' } };
  }

  private requireToken(): void {
    if (!this.token) throw new Error('Inicia sesión antes de llamar a VEKAI.');
  }

  private chatTimestamp(chat: Chat): number {
    return Date.parse(chat.modifiedAt ?? chat.createAt ?? '') || 0;
  }
}
