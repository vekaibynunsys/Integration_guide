import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
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

@Injectable({ providedIn: 'root' })
export class VekaiApiService {
  private token: string | null = null;
  private readonly api = '/api';

  constructor(private readonly http: HttpClient) {}

  async login(username: string, password: string): Promise<void> {
    const result = await firstValueFrom(this.http.post<{ id_token: string }>(`${this.api}/authenticate`, {
      username, password, rememberMe: false,
    }));
    this.token = result.id_token;
  }

  logout(): void {
    this.token = null;
  }

  listDomains(): Promise<Domain[]> {
    return firstValueFrom(this.http.get<Domain[]>(`${this.api}/domains?page=0&size=100`, this.options()));
  }

  createDomain(name: string): Promise<Domain> {
    return firstValueFrom(this.http.post<Domain>(`${this.api}/domains`, {
      name, description: '', instructions: '', lengthyResponse: false,
      llmKnowledge: false, reactRag: false, advancedTables: false,
    }, this.options()));
  }

  createChat(domainId: number, name: string): Promise<Chat> {
    return firstValueFrom(this.http.post<Chat>(`${this.api}/domains/${domainId}/chat`, { id: null, name }, this.options()));
  }

  renameChat(domainId: number, chatId: number, name: string): Promise<void> {
    return firstValueFrom(this.http.patch<void>(
      `${this.api}/domains/${domainId}/chat/${chatId}`, { id: chatId, name }, this.options()));
  }

  listChats(domainId: number): Promise<Chat[]> {
    return firstValueFrom(this.http.get<Chat[]>(
      `${this.api}/domains/${domainId}/chat?page=0&size=100&sort=modifiedAt,desc`, this.options()))
      .then(chats => chats.map(chat => ({ ...chat, domainId })));
  }

  listRecentChats(domainIds: number[], limit = 5): Promise<Chat[]> {
    const accessibleDomains = new Set(domainIds);
    return firstValueFrom(this.http.get<Chat[]>(
      `${this.api}/chats?page=0&size=100&sort=modifiedAt,desc`, this.options()))
      .then(chats => chats
        .map(chat => ({ ...chat, domainId: Number(chat.domainId ?? chat.domain?.id ?? 0) }))
        .filter(chat => chat.domainId > 0 && accessibleDomains.has(chat.domainId))
        .sort((a, b) => this.chatTimestamp(b) - this.chatTimestamp(a))
        .slice(0, limit));
  }

  uploadDocument(domainId: number, file: File): Promise<DomainDocument> {
    const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : 'binary';
    const form = new FormData();
    form.append('uploadFile', file, file.name);
    form.append('document', JSON.stringify({
      name: file.name, url: file.name, documentType: extension,
      documentSize: file.size, domain: { id: domainId },
    }));
    return firstValueFrom(this.http.post<DomainDocument>(`${this.api}/domains/${domainId}/documents`, form, this.options()));
  }

  listDocuments(domainId: number): Promise<DomainDocument[]> {
    return firstValueFrom(this.http.get<DomainDocument[]>(
      `${this.api}/domains/${domainId}/documents?page=0&size=100&sort=createAt,desc`, this.options()));
  }

  ask(domainId: number, chatId: number, question: string): Promise<Message> {
    return firstValueFrom(this.http.post<Message>(
      `${this.api}/domains/${domainId}/chat/${chatId}/messages`,
      { question, subdomainIds: [] }, this.options()));
  }

  getSources(domainId: number, chatId: number, messageId: number): Promise<MessageSource[]> {
    return firstValueFrom(this.http.get<MessageSource[]>(
      `${this.api}/domains/${domainId}/chat/${chatId}/messages/${messageId}/source`, this.options()));
  }

  viewDocument(domainId: number, documentId: number): Promise<Blob> {
    return firstValueFrom(this.http.get(
      `${this.api}/domains/${domainId}/documents/${documentId}/view`,
      { headers: this.options().headers, responseType: 'blob' },
    ));
  }

  getMessages(domainId: number, chatId: number): Promise<Message[]> {
    return firstValueFrom(this.http.get<Message[]>(
      `${this.api}/domains/${domainId}/chat/${chatId}/messages?page=0&size=100&sort=questionAskedAt,desc`,
      this.options()));
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
    const url = `${this.api}/domains/${domainId}/chats/${chatId}/messages/stream?question=${encodeURIComponent(question)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'text/event-stream' }, signal,
    });
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
        break;
      }
    }
  }

  private options(): { headers: HttpHeaders } {
    this.requireToken();
    return { headers: new HttpHeaders({ Authorization: `Bearer ${this.token}` }) };
  }

  private requireToken(): void {
    if (!this.token) throw new Error('Inicia sesión antes de llamar a VEKAI.');
  }

  private chatTimestamp(chat: Chat): number {
    return Date.parse(chat.modifiedAt ?? chat.createAt ?? '') || 0;
  }
}
