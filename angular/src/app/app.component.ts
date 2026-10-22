import { Component } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import MarkdownIt from 'markdown-it';
import { Chat, Domain, DomainDocument, Message, MessageSource, ReasoningStep, StreamEvent, VekaiApiService } from './vekai-api.service';

interface Turn { id?: number; question: string; response: string; reasoningSteps?: ReasoningStep[]; }
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

@Component({ selector: 'app-root', templateUrl: './app.component.html' })
export class AppComponent {
  authenticated = false;
  username = '';
  password = '';
  domains: Domain[] = [];
  domainId?: number;
  chats: Chat[] = [];
  chatId?: number;
  turns: Turn[] = [];
  question = '';
  answer = '';
  reasoning: ReasoningStep[] = [];
  sources: MessageSource[] = [];
  artifacts: unknown[] = [];
  documents: DomainDocument[] = [];
  activeStreamStep = '';
  uploadPhase: '' | 'uploading' | 'indexing' = '';
  uploadingDocumentName = '';
  status = '';
  busy = false;
  streaming = true;
  showDetails = false;
  showDocuments = false;
  showDomainForm = false;
  domainName = '';
  selectedSource?: MessageSource;
  documentViewerUrl?: SafeResourceUrl;
  documentDownloadUrl = '';
  documentViewerLoading = false;
  documentViewerError = '';
  private streamController?: AbortController;
  private uploadGeneration = 0;

  constructor(private readonly api: VekaiApiService, private readonly sanitizer: DomSanitizer) {}

  get selectedDomain(): Domain | undefined { return this.domains.find(domain => domain.id === this.domainId); }
  get visibleDomains(): Domain[] { return this.domains.slice(0, 5); }

  chatDomainName(chat: Chat): string {
    return chat.domain?.name ?? this.domains.find(domain => domain.id === chat.domainId)?.name ?? 'Espacio';
  }

  async login(): Promise<void> {
    await this.run('Iniciando sesión…', async () => {
      await this.api.login(this.username, this.password);
      this.domains = await this.api.listDomains();
      const activityChats = await this.api.listRecentChats(this.domains.map(domain => domain.id), 100);
      this.domains = this.sortDomainsByActivity(this.domains, activityChats);
      this.chats = activityChats.slice(0, 5);
      this.authenticated = true; this.status = '';
      if (this.domains[0]) await this.chooseDomain(this.domains[0].id);
    });
  }

  async chooseDomain(id: number): Promise<void> {
    this.closeDocumentViewer();
    if (id !== this.domainId) this.cancelDocumentPolling();
    this.promoteDomain(id);
    this.showDocuments = false; this.documents = [];
    this.reasoning = [];
    this.domainId = id; this.chatId = undefined; this.turns = []; this.answer = '';
    await this.run('Cargando chats…', async () => {
      const domainChats = await this.api.listChats(id); this.status = '';
      if (domainChats[0]) { this.chatId = domainChats[0].id; await this.loadChat(id, domainChats[0].id); }
    });
  }

  async chooseChat(chat: Chat): Promise<void> {
    this.closeDocumentViewer();
    if (!chat.domainId) { this.status = 'No se pudo identificar el espacio de esta conversación.'; return; }
    this.promoteDomain(chat.domainId);
    if (chat.domainId !== this.domainId) this.cancelDocumentPolling();
    this.domainId = chat.domainId; this.chatId = chat.id;
    this.showDocuments = false; this.documents = [];
    this.answer = ''; this.reasoning = []; this.sources = []; this.artifacts = [];
    await this.run('Cargando conversación…', async () => {
      await this.loadChat(chat.domainId, chat.id); this.status = '';
    });
  }

  async createDomain(): Promise<void> {
    if (!this.domainName.trim()) return;
    await this.run('Creando espacio…', async () => {
      const domain = await this.api.createDomain(this.domainName.trim());
      this.domains = [domain, ...this.domains]; this.domainName = ''; this.showDomainForm = false;
      await this.chooseDomain(domain.id);
    });
  }

  async createChat(): Promise<void> {
    if (!this.domainId) { this.status = 'Selecciona un espacio antes de crear un chat.'; return; }
    if (this.selectedDomain?.limitedAccess) {
      this.status = 'Este espacio está configurado como “Solo proyectos” y no admite chats directos de dominio.';
      return;
    }
    await this.run('Creando chat…', async () => {
      const chat = await this.api.createChat(this.domainId!, 'Nuevo chat');
      if (!chat?.id) throw new Error('VEKAI no devolvió el identificador del nuevo chat.');
      this.chats = [chat, ...this.chats.filter(item => item.id !== chat.id)].slice(0, 5);
      this.reasoning = []; this.chatId = chat.id; this.turns = []; this.status = '';
    });
  }

  logout(): void {
    this.closeDocumentViewer();
    this.cancelDocumentPolling();
    this.streamController?.abort(); this.api.logout();
    this.authenticated = false; this.password = ''; this.domains = []; this.domainId = undefined;
    this.chats = []; this.chatId = undefined; this.turns = []; this.question = ''; this.answer = '';
    this.reasoning = []; this.sources = []; this.artifacts = []; this.status = ''; this.showDetails = false;
    this.documents = []; this.showDocuments = false;
  }

  async openDocuments(): Promise<void> {
    if (!this.domainId) return;
    this.showDetails = false; this.showDocuments = true;
    await this.run('Cargando documentos…', async () => {
      this.documents = await this.api.listDocuments(this.domainId!); this.status = '';
    });
  }

  async upload(fileList: FileList | null): Promise<void> {
    const file = fileList?.item(0);
    if (!file || !this.domainId || this.uploadPhase) return;
    const domainId = this.domainId;
    const generation = ++this.uploadGeneration;
    this.uploadPhase = 'uploading'; this.uploadingDocumentName = file.name;
    this.showDetails = false; this.showDocuments = true; this.status = '';
    try {
      const uploaded = await this.api.uploadDocument(domainId, file);
      if (generation !== this.uploadGeneration) return;
      this.documents = this.mergeDocument(this.documents, uploaded);
      this.uploadPhase = 'indexing';
      await this.waitUntilDocumentIndexed(domainId, uploaded, generation);
    } catch (error) {
      if (generation === this.uploadGeneration) this.status = `Error: ${(error as Error).message}`;
    } finally {
      if (generation === this.uploadGeneration) {
        this.uploadPhase = ''; this.uploadingDocumentName = '';
      }
    }
  }

  async send(): Promise<void> {
    const prompt = this.question.trim();
    if (!prompt || !this.domainId || !this.chatId || this.busy) return;
    const firstQuestionTitle = this.turns.length === 0 ? this.buildChatTitle(prompt) : undefined;
    this.question = ''; this.answer = ''; this.reasoning = []; this.sources = []; this.artifacts = [];
    this.turns = [...this.turns, { question: prompt, response: '' }];
    if (!this.streaming) {
      await this.run('Consultando VEKAI…', async () => {
        if (firstQuestionTitle) await this.renameCurrentChat(firstQuestionTitle);
        const message = await this.api.ask(this.domainId!, this.chatId!, prompt);
        this.replaceLastTurn({ id: message.id, question: prompt, response: message.response ?? '', reasoningSteps: message.reasoningSteps ?? [] });
        this.answer = message.response ?? ''; await this.loadDetails(message); await this.refreshRecentChats(); this.status = '';
      });
      return;
    }

    this.activeStreamStep = 'Interpretando la petición…';
    this.streamController = new AbortController(); this.busy = true; this.status = '';
    try {
      if (firstQuestionTitle) await this.renameCurrentChat(firstQuestionTitle);
      await this.api.stream(this.domainId, this.chatId, prompt, event => this.consume(event), this.streamController.signal);
      const latest = (await this.api.getMessages(this.domainId, this.chatId))[0];
      if (latest) { await this.loadDetails(latest); await this.loadChat(this.domainId, this.chatId); }
      await this.refreshRecentChats();
      this.status = '';
    } catch (error) {
      if ((error as Error).name === 'AbortError') this.status = '';
      else this.status = `Error: ${(error as Error).message}`;
    } finally { this.busy = false; this.activeStreamStep = ''; }
  }

  onQuestionKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void this.send(); }
  }

  stopStream(): void { this.streamController?.abort(); }

  async openTurnDetails(turn: Turn): Promise<void> {
    if (!turn.id || !this.domainId || !this.chatId) return;
    this.showDocuments = false; this.showDetails = true;
    this.sources = []; this.reasoning = turn.reasoningSteps ?? []; this.artifacts = [];
    try {
      const [sources, mcp] = await Promise.all([
        this.api.getSources(this.domainId, this.chatId, turn.id),
        this.api.getMcpSources(this.domainId, this.chatId, turn.id),
      ]);
      this.sources = sources;
      if (!this.reasoning.length && mcp.length) this.reasoning = mcp;
    } catch (error) {
      this.status = `Error: ${(error as Error).message}`;
    }
  }

  private async loadChat(domainId: number, chatId: number): Promise<void> {
    const messages = await this.api.getMessages(domainId, chatId);
    const ordered = [...messages].reverse();
    this.turns = ordered.map((message, index) => ({
      id: message.id, question: message.question ?? '', response: message.response ?? '',
      reasoningSteps: message.reasoningSteps?.length
        ? message.reasoningSteps
        : (index === ordered.length - 1 ? this.reasoning : []),
    }));
  }

  private consume(event: StreamEvent | string): void {
    const append = (delta: string): void => {
      this.answer += delta;
      const last = this.turns[this.turns.length - 1];
      if (last) this.replaceLastTurn({ ...last, response: last.response + delta });
    };
    if (typeof event === 'string') { this.activeStreamStep = 'Redactando la respuesta…'; append(event); return; }
    if (event.type === 'start') this.activeStreamStep = 'Interpretando la petición…';
    if (event.type === 'text-start') this.activeStreamStep = 'Redactando la respuesta…';
    if (event.type === 'text-delta') {
      this.activeStreamStep = 'Redactando la respuesta…';
      append(String(event['delta'] ?? ''));
    }
    if (event.type === 'reasoning-delta') {
      const delta = String(event['delta'] ?? event['text'] ?? '');
      if (delta.trim()) this.activeStreamStep = this.cleanReasoningLabel(delta);
      this.reasoning = this.reduceReasoningSteps(this.reasoning, event);
    }
    if (event.type.startsWith('tool-')) {
      const toolName = String(event['toolName'] ?? '');
      if (event.type === 'tool-input-start' && (!this.activeStreamStep || this.activeStreamStep === 'Interpretando la petición…')) {
        this.activeStreamStep = toolName ? `Consultando ${this.humanize(toolName)}…` : 'Consultando fuentes y herramientas…';
      }
      this.reasoning = this.reduceReasoningSteps(this.reasoning, event);
    }
    if (event.type === 'data-vekai-progress-phase') {
      const data = event['data'] as Record<string, unknown> | undefined;
      this.activeStreamStep = String(data?.['description'] ?? '').trim()
        || this.progressPhaseLabel(String(data?.['phase'] ?? ''));
      this.reasoning = this.reduceReasoningSteps(this.reasoning, event);
    }
    if (event.type === 'text-start' || event.type === 'finish') {
      this.reasoning = this.reduceReasoningSteps(this.reasoning, event);
    }
    if (event.type === 'finish') this.activeStreamStep = '';
    if (event.type === 'data-vekai-context') {
      const data = event['data'] as { artifacts?: unknown[] } | undefined;
      this.artifacts = data?.artifacts ?? [];
    }
    if (this.reasoning.length) this.attachReasoningToLastTurn();
  }

  private async loadDetails(message: Message): Promise<void> {
    const [documents, mcp] = await Promise.all([
      this.api.getSources(this.domainId!, this.chatId!, message.id),
      this.api.getMcpSources(this.domainId!, this.chatId!, message.id),
    ]);
    this.sources = documents;
    const persistedReasoning = message.reasoningSteps?.length ? message.reasoningSteps : mcp;
    if (persistedReasoning.length) this.reasoning = persistedReasoning;
    this.artifacts = message.artifacts ?? [];
  }

  private replaceLastTurn(turn: Turn): void {
    this.turns = this.turns.map((item, index) => index === this.turns.length - 1 ? turn : item);
  }

  private attachReasoningToLastTurn(): void {
    this.turns = this.turns.map((turn, index) => index === this.turns.length - 1
      ? { ...turn, reasoningSteps: [...this.reasoning] }
      : turn);
  }

  private buildChatTitle(question: string): string {
    const words = question.replace(/\s+/g, ' ').trim().split(' ');
    const title = words.slice(0, 7).join(' ');
    return `${title}${words.length > 7 ? '…' : ''}`.slice(0, 80);
  }

  private async renameCurrentChat(name: string): Promise<void> {
    try {
      await this.api.renameChat(this.domainId!, this.chatId!, name);
      const current = this.chats.find(chat => chat.id === this.chatId);
      const renamed: Chat = current
        ? { ...current, name, modifiedAt: new Date().toISOString() }
        : { id: this.chatId!, domainId: this.domainId!, name, modifiedAt: new Date().toISOString() };
      this.chats = [renamed, ...this.chats.filter(chat => chat.id !== this.chatId)].slice(0, 5);
    } catch {
      // El fallo al renombrar no debe impedir que se envíe la primera pregunta.
    }
  }

  private cleanReasoningLabel(value: string): string {
    return value.replace(/^\s*#{1,6}\s+/, '').trim() || 'Razonando…';
  }

  private humanize(value: string): string {
    return value.replace(/[_-]+/g, ' ').trim();
  }

  private progressPhaseLabel(phase: string): string {
    const labels: Record<string, string> = {
      identifying_asset: 'Identificando el activo…', searching_history: 'Buscando en el historial…',
      searching_similar_assets: 'Buscando activos similares…', searching_similar_cases: 'Buscando casos similares…',
      consulting_documents: 'Consultando documentos…', calculating_indicators: 'Calculando indicadores…',
      updating_work_order: 'Actualizando la orden de trabajo…',
    };
    return labels[phase] ?? 'Procesando la información…';
  }

  reasoningStepLabel(step: ReasoningStep): string {
    if (step.kind === 'tool') return step.toolName ? this.humanize(step.toolName) : 'Consulta a herramienta';
    if (step.text?.trim()) return this.cleanReasoningLabel(step.text);
    return this.reasoningLabelKey(step.labelKey) ?? 'Paso de razonamiento';
  }

  visibleReasoningSteps(steps?: ReasoningStep[]): ReasoningStep[] {
    return (steps ?? []).filter(step => step.kind === 'tool' || Boolean(step.text?.trim()) || Boolean(step.labelKey));
  }

  sourceTitle(source: MessageSource, index: number): string {
    return source.document?.name
      ?? source.validatedKnowledge?.name
      ?? source.validatedKnowledge?.question
      ?? (source.sourceType === 'EXTERNAL_PLUGIN' ? 'Fuente externa' : `Fuente ${index + 1}`);
  }

  sourceText(source: MessageSource): string {
    return String(source.embeding ?? source.answer ?? source.validatedKnowledge?.answer ?? '').trim();
  }

  sourcePreview(source: MessageSource): string {
    const value = this.sourceText(source);
    return value.length > 300 ? `${value.slice(0, 300).trim()}…` : value;
  }

  formatSourceSize(bytes?: number): string {
    if (bytes == null || !Number.isFinite(bytes)) return '';
    if (bytes === 0) return '0 Bytes';
    const units = ['Bytes', 'KB', 'MB', 'GB'];
    const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** unit).toFixed(unit ? 2 : 0)} ${units[unit]}`;
  }

  renderMarkdown(value: string): string {
    return markdown.render(value ?? '');
  }

  async openSourceDocument(source: MessageSource): Promise<void> {
    if (!source.document?.id || !this.domainId) return;
    this.closeDocumentViewer();
    this.selectedSource = source; this.documentViewerLoading = true; this.documentViewerError = '';
    try {
      const response = await this.api.viewDocument(this.domainId, source.document.id);
      const fallbackMime = this.documentMimeType(source.document.documentType, source.document.name);
      const mime = !response.type || response.type === 'application/octet-stream' ? fallbackMime : response.type;
      const blob = response.type === mime ? response : new Blob([response], { type: mime });
      this.documentDownloadUrl = URL.createObjectURL(blob);
      const page = Math.max(1, Number.parseInt(source.documentPage ?? '1', 10) || 1);
      const viewerUrl = mime === 'application/pdf' ? `${this.documentDownloadUrl}#page=${page}&zoom=page-width` : this.documentDownloadUrl;
      this.documentViewerUrl = this.sanitizer.bypassSecurityTrustResourceUrl(viewerUrl);
    } catch (error) {
      this.documentViewerError = (error as Error).message;
    } finally {
      this.documentViewerLoading = false;
    }
  }

  closeDocumentViewer(): void {
    if (this.documentDownloadUrl) URL.revokeObjectURL(this.documentDownloadUrl);
    this.selectedSource = undefined; this.documentViewerUrl = undefined; this.documentDownloadUrl = '';
    this.documentViewerLoading = false; this.documentViewerError = '';
  }

  private documentMimeType(documentType?: string, name?: string): string {
    const type = `${documentType ?? ''} ${name?.split('.').pop() ?? ''}`.toLowerCase();
    if (type.includes('pdf')) return 'application/pdf';
    if (type.includes('html') || type.includes('web')) return 'text/html';
    if (type.includes('txt') || type.includes('text')) return 'text/plain';
    if (type.includes('png')) return 'image/png';
    if (type.includes('jpg') || type.includes('jpeg')) return 'image/jpeg';
    return 'application/octet-stream';
  }

  private reduceReasoningSteps(steps: ReasoningStep[], event: StreamEvent): ReasoningStep[] {
    const completeRunning = (items: ReasoningStep[]): ReasoningStep[] =>
      items.map(step => step.status === 'running' || step.status === 'active' ? { ...step, status: 'done' } : step);

    if (event.type === 'reasoning-delta') {
      const delta = String(event['delta'] ?? event['text'] ?? '');
      if (!delta.trim()) return steps;
      const eventId = String(event['id'] ?? `reasoning-${steps.length}`);
      const startsHeading = /^\s*#{1,6}\s+/.test(delta);
      const lastThoughtIndex = steps.map(step => step.kind).lastIndexOf('thought');
      if (!startsHeading && lastThoughtIndex >= 0) {
        return steps.map((step, index) => index === lastThoughtIndex
          ? { ...step, status: 'running', text: step.text ? `${step.text}${String(step.id) === eventId ? '' : '\n'}${delta}` : delta }
          : step);
      }
      return [...completeRunning(steps), {
        id: eventId, kind: 'thought', status: 'running', text: delta,
      }];
    }

    if (event.type === 'tool-input-start') {
      const id = String(event['toolCallId'] ?? `tool-${steps.length}`);
      if (steps.some(step => String(step.id) === id)) return steps;
      return [...steps, { id, kind: 'tool', status: 'running', toolName: String(event['toolName'] ?? '') }];
    }
    if (event.type === 'tool-input-available') {
      const id = String(event['toolCallId'] ?? '');
      return steps.map(step => String(step.id) === id ? {
        ...step, toolName: String(event['toolName'] ?? step.toolName ?? ''), toolInput: event['input'],
      } : step);
    }
    if (event.type === 'tool-output-available' || event.type === 'tool-output-error') {
      const id = String(event['toolCallId'] ?? '');
      return steps.map(step => String(step.id) === id ? {
        ...step, status: event.type === 'tool-output-error' ? 'error' : 'done',
        toolOutput: event['output'], toolErrorText: String(event['errorText'] ?? ''),
        durationMs: Number(event['durationMs']) || step.durationMs,
      } : step);
    }
    if (event.type === 'data-vekai-progress-phase') {
      const data = event['data'] as Record<string, unknown> | undefined;
      const text = String(data?.['description'] ?? '').trim() || this.progressPhaseLabel(String(data?.['phase'] ?? ''));
      const last = steps[steps.length - 1];
      if (last?.kind === 'thought' && last.text === text && last.status === 'running') return steps;
      return [...completeRunning(steps), { id: `phase-${steps.length}`, kind: 'thought', status: 'running', text }];
    }
    if (event.type === 'text-start' || event.type === 'finish') return completeRunning(steps);
    return steps;
  }

  private reasoningLabelKey(labelKey?: string): string | undefined {
    if (!labelKey) return undefined;
    const labels: Record<string, string> = {
      'brainExpApp.message.reasoning.steps.interpreting': 'Interpretando la petición',
      'brainExpApp.message.reasoning.steps.answer': 'Redactando la respuesta',
      'brainExpApp.message.reasoning.maintenancePhases.identifyingAsset': 'Identificando el activo',
      'brainExpApp.message.reasoning.maintenancePhases.searchingHistory': 'Buscando en el historial',
      'brainExpApp.message.reasoning.maintenancePhases.searchingSimilarAssets': 'Buscando activos similares',
      'brainExpApp.message.reasoning.maintenancePhases.searchingSimilarCases': 'Buscando casos similares',
      'brainExpApp.message.reasoning.maintenancePhases.consultingDocuments': 'Consultando documentos',
      'brainExpApp.message.reasoning.maintenancePhases.calculatingIndicators': 'Calculando indicadores',
      'brainExpApp.message.reasoning.maintenancePhases.updatingWorkOrder': 'Actualizando la orden de trabajo',
    };
    return labels[labelKey];
  }

  private async refreshRecentChats(): Promise<void> {
    this.chats = await this.api.listRecentChats(this.domains.map(domain => domain.id));
    this.domains = this.sortDomainsByActivity(this.domains, this.chats);
  }

  private async waitUntilDocumentIndexed(domainId: number, uploaded: DomainDocument, generation: number): Promise<void> {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (generation !== this.uploadGeneration) return;
      const documents = await this.api.listDocuments(domainId);
      if (generation !== this.uploadGeneration) return;
      this.documents = documents;
      const current = documents.find(document => document.id === uploaded.id)
        ?? documents.find(document => document.name === uploaded.name);
      if (current?.state === 'INDEXED' || current?.state === 'FINALIZED') return;
      if (current?.state === 'ERROR') throw new Error(`No se pudo indexar ${uploaded.name}.`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`La indexación de ${uploaded.name} continúa más tiempo de lo esperado.`);
  }

  private mergeDocument(documents: DomainDocument[], uploaded: DomainDocument): DomainDocument[] {
    return [uploaded, ...documents.filter(document => document.id !== uploaded.id && document.name !== uploaded.name)];
  }

  private cancelDocumentPolling(): void {
    this.uploadGeneration += 1; this.uploadPhase = ''; this.uploadingDocumentName = '';
  }

  private promoteDomain(id: number): void {
    const domain = this.domains.find(item => item.id === id);
    if (domain) this.domains = [domain, ...this.domains.filter(item => item.id !== id)];
  }

  private sortDomainsByActivity(domains: Domain[], chats: Chat[]): Domain[] {
    const latestChat = new Map<number, number>();
    for (const chat of chats) {
      const timestamp = Date.parse(chat.modifiedAt ?? chat.createAt ?? '') || 0;
      latestChat.set(chat.domainId, Math.max(latestChat.get(chat.domainId) ?? 0, timestamp));
    }
    return [...domains].sort((a, b) => {
      const activityA = latestChat.get(a.id) ?? (Date.parse(a.lastModifiedDate ?? a.createAt ?? '') || 0);
      const activityB = latestChat.get(b.id) ?? (Date.parse(b.lastModifiedDate ?? b.createAt ?? '') || 0);
      return activityB - activityA;
    });
  }

  private async run(label: string, action: () => Promise<void>): Promise<void> {
    this.busy = true; this.status = label;
    try { await action(); }
    catch (error) { this.status = `Error: ${(error as Error).message}`; }
    finally { this.busy = false; }
  }
}
