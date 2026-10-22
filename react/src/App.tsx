import { ChangeEvent, FormEvent, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import { Chat, Domain, DomainDocument, Message, MessageSource, ReasoningStep, StreamEvent, VekaiApi } from './vekai-api';

type Turn = { id?: number; question: string; response: string; reasoningSteps?: ReasoningStep[] };
const markdown = new MarkdownIt({ html: false, linkify: true, breaks: true });

export function App() {
  const api = useMemo(() => new VekaiApi(), []);
  const controller = useRef<AbortController | null>(null);
  const reasoningRef = useRef<ReasoningStep[]>([]);
  const uploadGeneration = useRef(0);
  const documentUrlRef = useRef('');
  const [authenticated, setAuthenticated] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [domains, setDomains] = useState<Domain[]>([]);
  const [domainId, setDomainId] = useState<number>();
  const [chats, setChats] = useState<Chat[]>([]);
  const [chatId, setChatId] = useState<number>();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningStep[]>([]);
  const [sources, setSources] = useState<MessageSource[]>([]);
  const [artifacts, setArtifacts] = useState<unknown[]>([]);
  const [documents, setDocuments] = useState<DomainDocument[]>([]);
  const [activeStreamStep, setActiveStreamStep] = useState('');
  const [uploadPhase, setUploadPhase] = useState<'' | 'uploading' | 'indexing'>('');
  const [uploadingDocumentName, setUploadingDocumentName] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const [showDetails, setShowDetails] = useState(false);
  const [showDocuments, setShowDocuments] = useState(false);
  const [showDomainForm, setShowDomainForm] = useState(false);
  const [domainName, setDomainName] = useState('');
  const [selectedSource, setSelectedSource] = useState<MessageSource>();
  const [documentViewerUrl, setDocumentViewerUrl] = useState('');
  const [documentDownloadUrl, setDocumentDownloadUrl] = useState('');
  const [documentViewerLoading, setDocumentViewerLoading] = useState(false);
  const [documentViewerError, setDocumentViewerError] = useState('');

  const selectedDomain = domains.find(domain => domain.id === domainId);
  const visibleDomains = domains.slice(0, 5);
  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true); setStatus(label);
    try { await action(); }
    catch (error) { setStatus(`Error: ${(error as Error).message}`); }
    finally { setBusy(false); }
  };

  const loadChat = async (domain: number, chat: number) => {
    const messages = await api.getMessages(domain, chat);
    const ordered = [...messages].reverse();
    setTurns(ordered.map((message, index) => ({
      id: message.id, question: message.question ?? '', response: message.response ?? '',
      reasoningSteps: message.reasoningSteps?.length
        ? message.reasoningSteps
        : (index === ordered.length - 1 ? reasoningRef.current : []),
    })));
  };

  const chooseChat = async (chat: Chat) => {
    closeDocumentViewer();
    if (!chat.domainId) { setStatus('No se pudo identificar el espacio de esta conversación.'); return; }
    setDomains(current => promoteDomain(current, chat.domainId));
    if (chat.domainId !== domainId) cancelDocumentPolling();
    setShowDocuments(false); setDocuments([]);
    setDomainId(chat.domainId); setChatId(chat.id);
    setAnswer(''); reasoningRef.current = []; setReasoning([]); setSources([]); setArtifacts([]);
    await run('Cargando conversación…', async () => { await loadChat(chat.domainId, chat.id); setStatus(''); });
  };

  const chooseDomain = async (id: number) => {
    closeDocumentViewer();
    if (id !== domainId) cancelDocumentPolling();
    setDomains(current => promoteDomain(current, id));
    setShowDocuments(false); setDocuments([]);
    reasoningRef.current = []; setReasoning([]);
    setDomainId(id); setChatId(undefined); setTurns([]); setAnswer('');
    await run('Cargando chats…', async () => {
      const result = await api.listChats(id); setStatus('');
      if (result[0]) { setChatId(result[0].id); await loadChat(id, result[0].id); }
    });
  };

  const login = (event: FormEvent) => {
    event.preventDefault();
    void run('Iniciando sesión…', async () => {
      await api.login(username, password);
      const domainResult = await api.listDomains();
      const activityChats = await api.listRecentChats(domainResult.map(domain => domain.id), 100);
      const sortedDomains = sortDomainsByActivity(domainResult, activityChats);
      setDomains(sortedDomains); setChats(activityChats.slice(0, 5)); setAuthenticated(true); setStatus('');
      if (sortedDomains[0]) await chooseDomain(sortedDomains[0].id);
    });
  };

  const createDomain = (event: FormEvent) => {
    event.preventDefault();
    void run('Creando espacio…', async () => {
      const domain = await api.createDomain(domainName);
      setDomains(current => [domain, ...current]); setDomainName(''); setShowDomainForm(false);
      await chooseDomain(domain.id);
    });
  };

  const createChat = () => {
    if (!domainId) { setStatus('Selecciona un espacio antes de crear un chat.'); return; }
    if (selectedDomain?.limitedAccess) {
      setStatus('Este espacio está configurado como “Solo proyectos” y no admite chats directos de dominio.');
      return;
    }
    void run('Creando chat…', async () => {
      const chat = await api.createChat(domainId, 'Nuevo chat');
      if (!chat?.id) throw new Error('VEKAI no devolvió el identificador del nuevo chat.');
      setChats(current => [chat, ...current.filter(item => item.id !== chat.id)].slice(0, 5));
      reasoningRef.current = []; setReasoning([]); setChatId(chat.id); setTurns([]); setStatus('');
    });
  };

  const logout = () => {
    closeDocumentViewer();
    cancelDocumentPolling();
    controller.current?.abort(); api.logout();
    setAuthenticated(false); setPassword(''); setDomains([]); setDomainId(undefined);
    setChats([]); setChatId(undefined); setTurns([]); setQuestion(''); setAnswer('');
    reasoningRef.current = []; setReasoning([]); setSources([]); setArtifacts([]); setStatus(''); setShowDetails(false);
    setDocuments([]); setShowDocuments(false);
  };

  const openDocuments = () => {
    if (!domainId) return;
    setShowDetails(false); setShowDocuments(true);
    void run('Cargando documentos…', async () => {
      setDocuments(await api.listDocuments(domainId)); setStatus('');
    });
  };

  const upload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !domainId || uploadPhase) return;
    const currentDomainId = domainId;
    const generation = ++uploadGeneration.current;
    setUploadPhase('uploading'); setUploadingDocumentName(file.name);
    setShowDetails(false); setShowDocuments(true); setStatus('');
    void (async () => {
      try {
        const uploaded = await api.uploadDocument(currentDomainId, file);
        if (generation !== uploadGeneration.current) return;
        setDocuments(current => mergeDocument(current, uploaded));
        setUploadPhase('indexing');
        await waitUntilDocumentIndexed(currentDomainId, uploaded, generation);
      } catch (error) {
        if (generation === uploadGeneration.current) setStatus(`Error: ${(error as Error).message}`);
      } finally {
        if (generation === uploadGeneration.current) {
          setUploadPhase(''); setUploadingDocumentName('');
        }
      }
    })();
  };

  const waitUntilDocumentIndexed = async (currentDomainId: number, uploaded: DomainDocument, generation: number) => {
    for (let attempt = 0; attempt < 150; attempt++) {
      if (generation !== uploadGeneration.current) return;
      const currentDocuments = await api.listDocuments(currentDomainId);
      if (generation !== uploadGeneration.current) return;
      setDocuments(currentDocuments);
      const current = currentDocuments.find(document => document.id === uploaded.id)
        ?? currentDocuments.find(document => document.name === uploaded.name);
      if (current?.state === 'INDEXED' || current?.state === 'FINALIZED') return;
      if (current?.state === 'ERROR') throw new Error(`No se pudo indexar ${uploaded.name}.`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`La indexación de ${uploaded.name} continúa más tiempo de lo esperado.`);
  };

  function cancelDocumentPolling() {
    uploadGeneration.current += 1; setUploadPhase(''); setUploadingDocumentName('');
  }

  const loadDetails = async (message: Message) => {
    const [documents, mcp] = await Promise.all([
      api.getSources(domainId!, chatId!, message.id), api.getMcpSources(domainId!, chatId!, message.id),
    ]);
    setSources(documents);
    const persistedReasoning = message.reasoningSteps?.length ? message.reasoningSteps : mcp;
    if (persistedReasoning.length) { reasoningRef.current = persistedReasoning; setReasoning(persistedReasoning); }
    setArtifacts(message.artifacts ?? []);
  };

  const openTurnDetails = async (turn: Turn) => {
    if (!turn.id || !domainId || !chatId) return;
    setShowDocuments(false); setShowDetails(true);
    setSources([]); reasoningRef.current = turn.reasoningSteps ?? []; setReasoning(reasoningRef.current); setArtifacts([]);
    try {
      const [messageSources, mcp] = await Promise.all([
        api.getSources(domainId, chatId, turn.id), api.getMcpSources(domainId, chatId, turn.id),
      ]);
      setSources(messageSources);
      if (!reasoningRef.current.length && mcp.length) { reasoningRef.current = mcp; setReasoning(mcp); }
    } catch (error) {
      setStatus(`Error: ${(error as Error).message}`);
    }
  };

  function closeDocumentViewer() {
    if (documentUrlRef.current) URL.revokeObjectURL(documentUrlRef.current);
    documentUrlRef.current = ''; setSelectedSource(undefined); setDocumentViewerUrl('');
    setDocumentDownloadUrl(''); setDocumentViewerLoading(false); setDocumentViewerError('');
  }

  const openSourceDocument = async (source: MessageSource) => {
    if (!source.document?.id || !domainId) return;
    closeDocumentViewer(); setSelectedSource(source); setDocumentViewerLoading(true);
    try {
      const response = await api.viewDocument(domainId, source.document.id);
      const fallbackMime = documentMimeType(source.document.documentType, source.document.name);
      const mime = !response.type || response.type === 'application/octet-stream' ? fallbackMime : response.type;
      const blob = response.type === mime ? response : new Blob([response], { type: mime });
      const rawUrl = URL.createObjectURL(blob);
      documentUrlRef.current = rawUrl; setDocumentDownloadUrl(rawUrl);
      const page = Math.max(1, Number.parseInt(source.documentPage ?? '1', 10) || 1);
      setDocumentViewerUrl(mime === 'application/pdf' ? `${rawUrl}#page=${page}&zoom=page-width` : rawUrl);
    } catch (error) {
      setDocumentViewerError((error as Error).message);
    } finally {
      setDocumentViewerLoading(false);
    }
  };

  const consume = (event: StreamEvent | string) => {
    const append = (delta: string) => {
      setAnswer(value => value + delta);
      setTurns(value => value.map((turn, index) => index === value.length - 1
        ? { ...turn, response: turn.response + delta } : turn));
    };
    if (typeof event === 'string') { setActiveStreamStep('Redactando la respuesta…'); append(event); return; }
    if (event.type === 'start') setActiveStreamStep('Interpretando la petición…');
    if (event.type === 'text-start') setActiveStreamStep('Redactando la respuesta…');
    if (event.type === 'text-delta') {
      setActiveStreamStep('Redactando la respuesta…');
      append(String(event['delta'] ?? ''));
    }
    if (event.type === 'reasoning-delta') {
      const delta = String(event['delta'] ?? event['text'] ?? '');
      if (delta.trim()) setActiveStreamStep(cleanReasoningLabel(delta));
      reasoningRef.current = reduceReasoningSteps(reasoningRef.current, event);
      setReasoning(reasoningRef.current);
    }
    if (event.type.startsWith('tool-')) {
      const toolName = String(event['toolName'] ?? '');
      if (event.type === 'tool-input-start') {
        setActiveStreamStep(current => !current || current === 'Interpretando la petición…'
          ? (toolName ? `Consultando ${humanize(toolName)}…` : 'Consultando fuentes y herramientas…') : current);
      }
      reasoningRef.current = reduceReasoningSteps(reasoningRef.current, event);
      setReasoning(reasoningRef.current);
    }
    if (event.type === 'data-vekai-progress-phase') {
      const data = event['data'] as Record<string, unknown> | undefined;
      setActiveStreamStep(String(data?.['description'] ?? '').trim() || progressPhaseLabel(String(data?.['phase'] ?? '')));
      reasoningRef.current = reduceReasoningSteps(reasoningRef.current, event);
      setReasoning(reasoningRef.current);
    }
    if (event.type === 'text-start' || event.type === 'finish') {
      reasoningRef.current = reduceReasoningSteps(reasoningRef.current, event);
      setReasoning(reasoningRef.current);
    }
    if (event.type === 'finish') setActiveStreamStep('');
    if (event.type === 'data-vekai-context') {
      const data = event['data'] as { artifacts?: unknown[] } | undefined;
      setArtifacts(data?.artifacts ?? []);
    }
    if (reasoningRef.current.length) {
      const currentReasoning = [...reasoningRef.current];
      setTurns(value => value.map((turn, index) => index === value.length - 1
        ? { ...turn, reasoningSteps: currentReasoning }
        : turn));
    }
  };

  const renameCurrentChat = async (domain: number, chat: number, name: string) => {
    try {
      await api.renameChat(domain, chat, name);
      setChats(current => {
        const existing = current.find(item => item.id === chat);
        const renamed: Chat = existing
          ? { ...existing, name, modifiedAt: new Date().toISOString() }
          : { id: chat, domainId: domain, name, modifiedAt: new Date().toISOString() };
        return [renamed, ...current.filter(item => item.id !== chat)].slice(0, 5);
      });
    } catch {
      // El fallo al renombrar no debe impedir que se envíe la primera pregunta.
    }
  };

  const send = async () => {
    const prompt = question.trim();
    if (!prompt || !domainId || !chatId || busy) return;
    const firstQuestionTitle = turns.length === 0 ? buildChatTitle(prompt) : undefined;
    setQuestion(''); setAnswer(''); reasoningRef.current = []; setReasoning([]); setSources([]); setArtifacts([]);
    setTurns(value => [...value, { question: prompt, response: '' }]);
    if (!streaming) {
      await run('Consultando VEKAI…', async () => {
        if (firstQuestionTitle) await renameCurrentChat(domainId, chatId, firstQuestionTitle);
        const message = await api.ask(domainId, chatId, prompt);
        setTurns(value => value.map((turn, index) => index === value.length - 1
          ? { id: message.id, question: prompt, response: message.response ?? '', reasoningSteps: message.reasoningSteps ?? [] } : turn));
        setAnswer(message.response ?? ''); await loadDetails(message);
        setChats(await api.listRecentChats(domains.map(domain => domain.id))); setStatus('');
      });
      return;
    }
    setActiveStreamStep('Interpretando la petición…');
    controller.current = new AbortController(); setBusy(true); setStatus('');
    try {
      if (firstQuestionTitle) await renameCurrentChat(domainId, chatId, firstQuestionTitle);
      await api.stream(domainId, chatId, prompt, consume, controller.current.signal);
      const latest = (await api.getMessages(domainId, chatId))[0];
      if (latest) { await loadDetails(latest); await loadChat(domainId, chatId); }
      setChats(await api.listRecentChats(domains.map(domain => domain.id)));
      setStatus('');
    } catch (error) {
      if ((error as Error).name === 'AbortError') setStatus('');
      else setStatus(`Error: ${(error as Error).message}`);
    } finally { setBusy(false); setActiveStreamStep(''); }
  };

  if (!authenticated) return <Login
    username={username} password={password} busy={busy} status={status}
    setUsername={setUsername} setPassword={setPassword} onSubmit={login}
  />;

  return <div className="app-shell">
    <aside className="sidebar">
      <Brand />
      <button className="new-chat" onClick={createChat} disabled={busy}><Icon name="plus" /> Nuevo chat</button>

      <div className="nav-heading"><span><Icon name="spaces" /> Espacios</span><button aria-label="Crear espacio" onClick={() => setShowDomainForm(value => !value)}>+</button></div>
      {showDomainForm && <form className="inline-form" onSubmit={createDomain}>
        <input autoFocus value={domainName} onChange={event => setDomainName(event.target.value)} placeholder="Nombre del espacio" />
        <button disabled={!domainName || busy}>Crear</button>
      </form>}
      <nav className="domain-list" aria-label="Espacios">
        {visibleDomains.map(domain => <button key={domain.id} className={domain.id === domainId ? 'active' : ''}
          onClick={() => void chooseDomain(domain.id)} title={domain.limitedAccess ? 'Solo proyectos' : domain.name}><span className="domain-dot" />{domain.name}{domain.limitedAccess && <small className="domain-mode">Solo proyectos</small>}</button>)}
      </nav>

      <div className="nav-heading chats-heading"><span><Icon name="chat" /> Chats recientes</span></div>
      <nav className="chat-list" aria-label="Chats">
        {chats.map(chat => <button key={chat.id} className={chat.id === chatId ? 'active' : ''}
          onClick={() => void chooseChat(chat)}><small>{chat.domain?.name ?? domains.find(domain => domain.id === chat.domainId)?.name ?? 'Espacio'}</small><span>{chat.name || `Chat ${chat.id}`}</span></button>)}
        {chats.length === 0 && <p className="empty-nav">Todavía no hay conversaciones.</p>}
      </nav>

      <div className="profile"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><span className="identity"><strong>{username.split('@')[0]}</strong><small>{username}</small></span><button className="logout" onClick={logout} title="Cerrar sesión" aria-label="Cerrar sesión">↪</button></div>
    </aside>

    <main className="chat-workspace">
      <header className="chat-header">
        <div><span className="space-label">Espacio</span><h1>{selectedDomain?.name ?? 'Selecciona un espacio'}</h1></div>
        <div className="header-actions">
          <button className="header-new-chat" onClick={createChat} disabled={!domainId || busy || selectedDomain?.limitedAccess}><Icon name="plus" /> Nuevo chat</button>
          <button className="documents-button" onClick={openDocuments} disabled={!domainId}><Icon name="document" /> Documentos</button>
          <label className={uploadPhase ? 'upload loading' : 'upload'}>{uploadPhase ? <span className="upload-spinner" /> : <Icon name="upload" />} {uploadPhase === 'uploading' ? 'Subiendo…' : uploadPhase === 'indexing' ? 'Indexando…' : 'Subir documento'}<input type="file" onChange={upload} disabled={!domainId || Boolean(uploadPhase)} /></label>
          <button className={streaming ? 'mode active' : 'mode'} onClick={() => setStreaming(value => !value)}><span /> Streaming</button>
        </div>
      </header>
      {status && <div className={status.startsWith('Error') || status.includes('Solo proyectos') ? 'global-status error' : 'global-status'}>{status}</div>}

      <section className="conversation">
        {!chatId ? <EmptyState title={domainId ? 'Empieza una conversación' : 'Selecciona un espacio'}
          text={domainId ? 'Crea un chat para preguntar sobre los documentos del espacio.' : 'Elige un espacio del menú lateral.'}
          action={domainId ? createChat : undefined} />
        : turns.length === 0 ? <EmptyState title={`Pregunta sobre ${selectedDomain?.name}`}
          text="VEKAI responderá utilizando el conocimiento disponible en este espacio." />
        : <div className="messages">{turns.map((turn, index) => <div className="turn" key={turn.id ?? index}>
          <div className="user-message"><span className="avatar">{username.slice(0, 1).toUpperCase()}</span><p>{turn.question}</p></div>
          <div className="assistant-message"><span className="vekai-mark">V</span><div>
            <strong>VEKAI</strong>
            {((busy && streaming && index === turns.length - 1) || visibleReasoningSteps(turn.reasoningSteps).length > 0) && (() => {
              const live = busy && index === turns.length - 1;
              const steps = visibleReasoningSteps(turn.reasoningSteps);
              const count = steps.length || 1;
              return <details className={live ? 'reasoning-history streaming' : 'reasoning-history'} open={live || undefined} aria-live="polite">
                <summary><span className="reasoning-summary-icon">{live ? '•' : '✓'}</span> {live ? 'Razonando' : 'Razonamiento completado'} <small>{count} {count === 1 ? 'paso' : 'pasos'}</small></summary>
                <ol>
                  {live && steps.length === 0 && <li className="running"><span className="reasoning-step-marker">•</span><div><strong>{activeStreamStep || 'Interpretando la petición…'}</strong></div></li>}
                  {steps.map((step, stepIndex) => {
                    const running = step.status === 'running' || step.status === 'active';
                    return <li className={step.status === 'error' ? 'error' : running ? 'running' : ''} key={String(step.id ?? stepIndex)}>
                      <span className="reasoning-step-marker">{step.status === 'error' ? '!' : running ? '•' : '✓'}</span><div><strong>{reasoningStepLabel(step)}</strong>{step.durationMs && <small>{step.durationMs} ms</small>}{step.toolErrorText && <p>{step.toolErrorText}</p>}</div>
                    </li>;
                  })}
                </ol>
              </details>;
            })()}
            {turn.response && <MarkdownContent value={turn.response} />}
            {turn.response && turn.id && <button className="details-link" onClick={() => void openTurnDetails(turn)}><Icon name="source" /> Ver fuentes y razonamiento</button>}
          </div></div>
        </div>)}</div>}
      </section>

      {chatId && <footer className="composer-wrap">
        <div className="composer"><label className="attach" title="Subir documento"><Icon name="paperclip" /><input type="file" onChange={upload} /></label>
          <textarea rows={1} value={question} disabled={busy} placeholder="Escribe una pregunta sobre este espacio…"
            onChange={event => setQuestion(event.target.value)} onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }} />
          {busy ? <button className="send stop" onClick={() => controller.current?.abort()} aria-label="Detener">■</button>
            : <button className="send" onClick={() => void send()} disabled={!question.trim()} aria-label="Enviar"><Icon name="send" /></button>}
        </div>
        <small>El texto mostrado ha sido generado por una IA. Revisa la información relevante.</small>
      </footer>}
    </main>

    {showDetails && <aside className="details-panel"><header><div><span className="space-label">Respuesta</span><h2>Fuentes y razonamiento</h2></div><button onClick={() => setShowDetails(false)}>×</button></header>
      <SourceList sources={sources} onOpen={openSourceDocument} />
      <Detail title="Razonamiento y herramientas" value={reasoning} empty="No hay pasos de razonamiento disponibles." />
      <Detail title="Artefactos" value={artifacts} empty="No hay artefactos asociados." />
    </aside>}
    {showDocuments && <aside className="details-panel documents-panel"><header><div><span className="space-label">{selectedDomain?.name}</span><h2>Documentos</h2></div><button onClick={() => setShowDocuments(false)}>×</button></header>
      {uploadPhase && <div className="indexing-banner"><span className="upload-spinner" /><div><strong>{uploadPhase === 'uploading' ? 'Subiendo documento' : 'Indexando documento'}</strong><small>{uploadingDocumentName}</small></div></div>}
      <p className="panel-summary">{documents.length} documentos ordenados por fecha de incorporación.</p>
      {documents.length ? <div className="document-list">{documents.map(document => <article className="document-item" key={document.id}>
        <span className="document-icon">{(document.documentType || 'DOC').slice(0, 3).toUpperCase()}</span><div><strong>{document.name}</strong><small>{formatDocumentDate(document.createAt)}{document.createdBy ? ` · ${document.createdBy}` : ''}</small></div>
        <span className={`document-state ${document.state === 'INDEXED' || document.state === 'FINALIZED' ? 'ready' : ''}`}>{document.state || document.sourceType || 'Disponible'}</span>
      </article>)}</div> : <p className="panel-empty">Este espacio todavía no contiene documentos.</p>}
    </aside>}
    {selectedSource && <div className="document-viewer-backdrop" onClick={closeDocumentViewer}>
      <section className="document-viewer" role="dialog" aria-modal="true" aria-label="Vista del documento" onClick={event => event.stopPropagation()}>
        <header><div><span className="space-label">Fuente · Página {selectedSource.documentPage || 1}</span><h2>{selectedSource.document?.name || 'Documento'}</h2></div><div className="viewer-actions">{documentDownloadUrl && <a href={documentDownloadUrl} target="_blank" rel="noreferrer">Abrir aparte</a>}<button onClick={closeDocumentViewer} aria-label="Cerrar">×</button></div></header>
        <div className="document-viewer-body">
          <aside className="document-viewer-context">
            <p>{sourceText(selectedSource) || 'Este fragmento no contiene texto para mostrar.'}</p>
            <strong>Página {selectedSource.documentPage || 1}</strong>
            <div className="viewer-document-chip"><span>{(selectedSource.document?.documentType || 'DOC').slice(0, 3).toUpperCase()}</span><span>{selectedSource.document?.name}<small>{selectedSource.document?.documentSize != null ? `(${formatSourceSize(selectedSource.document.documentSize)})` : ''}</small></span></div>
          </aside>
          <div className="document-viewer-preview">
            {documentViewerLoading && <div className="viewer-loading"><span className="upload-spinner" />Cargando documento…</div>}
            {documentViewerError && <div className="viewer-error"><strong>No se pudo abrir el documento</strong><span>{documentViewerError}</span></div>}
            {documentViewerUrl && !documentViewerLoading && <iframe src={documentViewerUrl} title={selectedSource.document?.name || 'Documento'} />}
          </div>
        </div>
      </section>
    </div>}
  </div>;
}

function MarkdownContent({ value }: { value: string }) {
  return <div className="markdown-content" dangerouslySetInnerHTML={{ __html: markdown.render(value) }} />;
}

function SourceList({ sources, onOpen }: { sources: MessageSource[]; onOpen: (source: MessageSource) => void }) {
  return <section className="detail-section source-section"><h3>Fuentes <span>{sources.length}</span></h3>
    {sources.length ? <div className="source-list">{sources.map((source, index) => {
      const text = sourceText(source);
      return <article className={`source-card ${source.document?.id ? 'clickable' : ''}`} key={String(source.id ?? index)} tabIndex={source.document?.id ? 0 : undefined} onClick={() => onOpen(source)} onKeyDown={event => { if (event.key === 'Enter') onOpen(source); }}>
        <div className="source-card-header"><span className="source-file-icon">{(source.document?.documentType || source.sourceType || 'DOC').slice(0, 3).toUpperCase()}</span><div><strong>{sourceTitle(source, index)}</strong><small>{source.sourceType || 'DOCUMENT'}</small></div></div>
        {text && <p className="source-preview">{text.length > 300 ? `${text.slice(0, 300).trim()}…` : text}</p>}
        {text.length > 300 && <details className="source-full" onClick={event => event.stopPropagation()}><summary>Expandir fragmento</summary><p>{text}</p></details>}
        <div className="source-meta">{source.documentPage && <span>Página <strong>{source.documentPage}</strong></span>}{source.document?.name && <span>{source.document.name}{source.document.documentSize != null ? ` · ${formatSourceSize(source.document.documentSize)}` : ''}</span>}</div>
        {source.document?.id && <span className="source-open-hint">Pincha aquí para ver el documento en la página {source.documentPage || 1} →</span>}
      </article>;
    })}</div> : <p>No se devolvieron fuentes documentales.</p>}
  </section>;
}

function sourceTitle(source: MessageSource, index: number): string {
  return source.document?.name ?? source.validatedKnowledge?.name ?? source.validatedKnowledge?.question
    ?? (source.sourceType === 'EXTERNAL_PLUGIN' ? 'Fuente externa' : `Fuente ${index + 1}`);
}

function sourceText(source: MessageSource): string {
  return String(source.embeding ?? source.answer ?? source.validatedKnowledge?.answer ?? '').trim();
}

function formatSourceSize(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const units = ['Bytes', 'KB', 'MB', 'GB'];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

function documentMimeType(documentType?: string, name?: string): string {
  const type = `${documentType ?? ''} ${name?.split('.').pop() ?? ''}`.toLowerCase();
  if (type.includes('pdf')) return 'application/pdf';
  if (type.includes('html') || type.includes('web')) return 'text/html';
  if (type.includes('txt') || type.includes('text')) return 'text/plain';
  if (type.includes('png')) return 'image/png';
  if (type.includes('jpg') || type.includes('jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

function Login(props: { username: string; password: string; busy: boolean; status: string;
  setUsername: (value: string) => void; setPassword: (value: string) => void; onSubmit: (event: FormEvent) => void }) {
  return <main className="login-page"><Brand /><form className="login-card" onSubmit={props.onSubmit}>
    <div className="login-intro"><span className="eyebrow">VEKAI API · React</span><h1>Inicia sesión en VEKAI</h1><p>Consulta tus espacios y conversa con su conocimiento desde una integración real.</p></div>
    <label>Correo electrónico<input type="email" autoComplete="username" value={props.username} onChange={event => props.setUsername(event.target.value)} /></label>
    <label>Contraseña<input type="password" autoComplete="current-password" value={props.password} onChange={event => props.setPassword(event.target.value)} /></label>
    {props.status && <p className={props.status.startsWith('Error') ? 'login-status error' : 'login-status'}>{props.status}</p>}
    <button className="login-button" disabled={props.busy || !props.username || !props.password}>{props.busy ? 'Accediendo…' : 'Iniciar sesión'}</button>
    <small>Ejemplo de integración · v3.12.0-rc-mcp</small>
  </form></main>;
}

function Brand() { return <div className="brand"><img src="/assets/vekai-logo.svg" alt="VEKAI by NUNSYS" /></div>; }

function EmptyState({ title, text, action }: { title: string; text: string; action?: () => void }) {
  return <div className="empty-state"><span className="empty-logo">V</span><h2>{title}</h2><p>{text}</p>{action && <button onClick={action}>Crear nuevo chat</button>}</div>;
}

function Detail({ title, value, empty }: { title: string; value: unknown[]; empty: string }) {
  return <section className="detail-section"><h3>{title}<span>{value.length}</span></h3>{value.length
    ? <pre>{JSON.stringify(value, null, 2)}</pre> : <p>{empty}</p>}</section>;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    plus: 'M12 5v14M5 12h14', spaces: 'M4 5h16v14H4zM8 5v14', chat: 'M4 5h16v12H8l-4 3z',
    upload: 'M12 16V4m0 0L7 9m5-5 5 5M5 20h14', paperclip: 'M8 12.5l6.2-6.2a3 3 0 114.2 4.2l-8.5 8.5a5 5 0 11-7.1-7.1l8.5-8.5',
    send: 'M4 4l17 8-17 8 3-8-3-8zm3 8h14', source: 'M7 3h10v18H7zM10 8h4m-4 4h4m-4 4h3', document: 'M6 3h9l3 3v15H6zM14 3v4h4M9 11h6m-6 4h6',
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d={paths[name]} /></svg>;
}

function promoteDomain(domains: Domain[], id: number): Domain[] {
  const domain = domains.find(item => item.id === id);
  return domain ? [domain, ...domains.filter(item => item.id !== id)] : domains;
}

function sortDomainsByActivity(domains: Domain[], chats: Chat[]): Domain[] {
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

function cleanReasoningLabel(value: string): string {
  return value.replace(/^\s*#{1,6}\s+/, '').trim() || 'Razonando…';
}

function buildChatTitle(question: string): string {
  const words = question.replace(/\s+/g, ' ').trim().split(' ');
  const title = words.slice(0, 7).join(' ');
  return `${title}${words.length > 7 ? '…' : ''}`.slice(0, 80);
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, ' ').trim();
}

function progressPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    identifying_asset: 'Identificando el activo…', searching_history: 'Buscando en el historial…',
    searching_similar_assets: 'Buscando activos similares…', searching_similar_cases: 'Buscando casos similares…',
    consulting_documents: 'Consultando documentos…', calculating_indicators: 'Calculando indicadores…',
    updating_work_order: 'Actualizando la orden de trabajo…',
  };
  return labels[phase] ?? 'Procesando la información…';
}

function reduceReasoningSteps(steps: ReasoningStep[], event: StreamEvent): ReasoningStep[] {
  const completeRunning = (items: ReasoningStep[]) =>
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
    const text = String(data?.['description'] ?? '').trim() || progressPhaseLabel(String(data?.['phase'] ?? ''));
    const last = steps[steps.length - 1];
    if (last?.kind === 'thought' && last.text === text && last.status === 'running') return steps;
    return [...completeRunning(steps), { id: `phase-${steps.length}`, kind: 'thought', status: 'running', text }];
  }
  if (event.type === 'text-start' || event.type === 'finish') return completeRunning(steps);
  return steps;
}

function visibleReasoningSteps(steps?: ReasoningStep[]): ReasoningStep[] {
  return (steps ?? []).filter(step => step.kind === 'tool' || Boolean(step.text?.trim()) || Boolean(step.labelKey));
}

function reasoningStepLabel(step: ReasoningStep): string {
  if (step.kind === 'tool') return step.toolName ? humanize(step.toolName) : 'Consulta a herramienta';
  if (step.text?.trim()) return cleanReasoningLabel(step.text);
  return reasoningLabelKey(step.labelKey) ?? 'Paso de razonamiento';
}

function reasoningLabelKey(labelKey?: string): string | undefined {
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

function formatDocumentDate(value?: string): string {
  return value ? new Intl.DateTimeFormat('es-ES', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)) : 'Sin fecha';
}

function mergeDocument(documents: DomainDocument[], uploaded: DomainDocument): DomainDocument[] {
  return [uploaded, ...documents.filter(document => document.id !== uploaded.id && document.name !== uploaded.name)];
}
