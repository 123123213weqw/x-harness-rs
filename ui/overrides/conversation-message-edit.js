// History is immutable. Editing is a session-scoped draft transaction.
function xhEditStorage() {
  let db;
  const fileBytes = new WeakMap();
  // Store portable bytes, not browser-specific File handles (WebKit can abort
  // IndexedDB transactions containing File blobs). Cache immutable File reads.
  async function encodeDraft(draft) {
    if (!draft) return draft;
    return {...draft, images: await Promise.all((draft.images || []).map(async image => {
      if (!image.file) return image;
      if (!fileBytes.has(image.file)) fileBytes.set(image.file, image.file.arrayBuffer());
      return {blob: await fileBytes.get(image.file), name:image.file.name,
        type:image.file.type, lastModified:image.file.lastModified};
    }))};
  }
  function decodeDraft(draft) {
    if (!draft) return draft;
    return {...draft, images:(draft.images || []).map(image => image.blob
      ? {file:new File([image.blob],image.name,{type:image.type,lastModified:image.lastModified})} : image)};
  }
  async function access(mode, operation) {
    db ??= new Promise((resolve, reject) => {
      const request = indexedDB.open('xharness-message-edits-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('drafts');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const database = await db;
    return new Promise((resolve, reject) => {
      const tx = database.transaction('drafts', mode);
      const request = operation(tx.objectStore('drafts'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error || new Error('Draft storage failed'));
    });
  }
  return { load: async id => {
      const record = await access('readonly', s => s.get(id));
      return record && {...record,backup:decodeDraft(record.backup),draft:decodeDraft(record.draft)};
    },
    save: async (id, value) => {
      const record = {...value,backup:await encodeDraft(value.backup),draft:await encodeDraft(value.draft)};
      return access('readwrite', s => s.put(record, id));
    },
    remove: id => access('readwrite', s => s.delete(id)) };
}
const xhEditPersistence = xhEditStorage();
class XHarnessMessageEditor {
  listeners = new Set();
  state = { phase: 'idle', editing: false, error: '' };
  backup = null;
  ownChange = false;
  disposed = false;
  writes = Promise.resolve();
  constructor(deps) {
    this.d = deps;
    this.off = deps.shell.state.subscribe(() => {
      if (this.state.editing && !this.ownChange && !this.disposed && !this.busy()) this.persist().catch(()=>{});
    });
    this.ready = deps.storage.load(deps.id).then(record => {
      if (record && !this.disposed && this.state.phase === 'idle') {
        this.saved = record;
        this.set({ phase: 'recover' });
      }
    }).catch(error => this.set({ error: String(error) }));
  }
  subscribe = fn => { this.listeners.add(fn); return () => this.listeners.delete(fn); };
  getSnapshot = () => this.state;
  set(next) { if (this.disposed) return; this.state = { ...this.state, ...next }; for (const fn of this.listeners) fn(); }
  busy() { const s = this.d.shell; return s.disposed || s.imageSendInFlight || ['adjudicating','submitting'].includes(s.snapshot.phase); }
  capture() {
    const s = this.d.shell.snapshot;
    const images = this.d.conversation.draftImages(s.imageIds);
    if (images.length !== s.imageIds.length) throw new Error(this.d.t('message.editMissing'));
    return { text: s.draft, images: images.map(a => a.historyRef
      ? { ref: a.historyRef, name: a.file.name, type: a.file.type }
      : { file: a.file }) };
  }
  persist() {
    try {
      const record = { version: 1, backup: this.backup, draft: this.capture() };
      this.writes = this.writes.catch(() => {}).then(() => this.d.storage.save(this.d.id, record));
      this.writes.catch(e => this.set({ error: this.d.t('message.editStorage') + ': ' + String(e) }));
      return this.writes;
    } catch(e) { this.set({ error: String(e) }); return Promise.reject(e); }
  }
  async request(content) {
    await this.ready;
    if (this.disposed || this.busy() || this.d.running()) return;
    if (this.state.phase !== 'idle') { this.set({error:this.d.t('message.editFinish')}); return; }
    if (!Array.isArray(content) || content.some(b => b.type !== 'text' && b.type !== 'image')) {
      this.set({error:this.d.t('message.editUnsupported')}); return;
    }
    this.pending = { text: content.filter(b => b.type === 'text').map(b => b.text).join(''),
      images: content.filter(b => b.type === 'image').map(b => ({ref: b.attachment, name: b.attachment?.name || 'image', type:b.attachment?.mediaType})) };
    if (this.pending.images.some(a => !a.ref?.attachmentId)) { this.set({error:this.d.t('message.editMissing')}); return; }
    const before = this.capture();
    if (before.text || before.images.length) this.set({phase:'confirm',error:''});
    else await this.confirm();
  }
  async confirm() {
    if (!this.pending || this.busy() || this.d.running() || this.state.editing) return;
    this.set({phase:'saving',error:''});
    const snapshot = this.d.shell.snapshot;
    try {
      this.backup = this.capture();
      await this.d.storage.save(this.d.id, {version:1,backup:this.backup,draft:this.pending});
      if (this.disposed) return;
      // User typing, a network update, or a second submit must not lose a newer draft.
      if (snapshot !== this.d.shell.snapshot || this.busy() || this.d.running()) throw new Error(this.d.t('message.editChanged'));
      this.apply(this.pending);
      this.pending = null;
      this.set({phase:'editing',editing:true,error:''});
      this.d.focus();
    } catch(e) {
      await this.d.storage.remove(this.d.id).catch(() => {});
      this.backup = null; this.set({phase:'idle',error:String(e)});
    }
  }
  apply(draft) {
    const shell = this.d.shell, conversation = this.d.conversation;
    const old = [...shell.snapshot.imageIds];
    const images = [];
    try { for (const a of draft.images || []) {
      const file = a.file || new File([], a.name || 'image', {type:a.type || 'image/png'});
      const image = conversation.createDraftImages([file])[0];
      if (a.ref) { image.historyRef = a.ref; image.loadState = 'loading'; }
      images.push(image);
    } } catch (error) {
      for (const image of images) conversation.releaseDraftImage(image.id);
      throw error;
    }
    this.ownChange = true;
    for (const id of old) shell.removeImage(id);
    shell.addImages(images.map(a => a.id)); shell.setDraft(draft.text);
    this.ownChange = false;
    for (const id of old) conversation.releaseDraftImage(id);
    for (const a of images) if (a.historyRef) this.hydrate(a);
  }
  async hydrate(image) {
    const generation = image.generation = (image.generation || 0) + 1;
    image.loadState = 'loading'; this.set({});
    try {
      const result = await this.d.read(image.historyRef.attachmentId);
      if (!result.ok) throw new Error(result.error.message);
      if (this.disposed || generation !== image.generation || !this.d.conversation.draftImages([image.id]).length) return;
      const file = new File([result.value.data], image.file.name, {type:result.value.attachment.mediaType});
      const url = URL.createObjectURL(file);
      this.d.conversation.createdImageUrls.add(url);
      this.d.conversation.createdImageUrls.delete(image.previewUrl);
      URL.revokeObjectURL(image.previewUrl);
      image.file = file; image.previewUrl = url; image.loadState = 'ready';
    } catch(e) { if (generation !== image.generation) return; image.loadState = 'missing'; image.loadError = String(e); }
    if (!this.disposed) { this.ownChange = true; this.d.shell.publish(); this.ownChange = false; this.set({}); }
  }
  async recover() {
    if (!this.saved || this.busy() || this.d.running()) return;
    // A refresh can seed the ordinary text mirror before this transaction loads.
    const draft = this.d.shell.snapshot;
    if ((draft.draft && draft.draft !== this.saved.draft.text) || draft.imageIds.length) {
      this.set({error:this.d.t('message.editChanged')}); return;
    }
    this.backup = this.saved.backup; this.apply(this.saved.draft); this.saved = null;
    this.set({phase:'editing',editing:true,error:''}); this.d.focus();
  }
  async cancel() {
    if (this.busy() || this.state.phase === 'saving') return;
    if (this.state.phase === 'confirm') { this.pending = null; this.set({phase:'idle',error:''}); return; }
    if (this.state.phase === 'recover') {
      const draft = this.d.shell.snapshot;
      if ((draft.draft && draft.draft !== this.saved.draft.text) || draft.imageIds.length) { this.set({error:this.d.t('message.editChanged')}); return; }
      this.backup = this.saved.backup;
    }
    if (this.backup) this.apply(this.backup);
    this.set({phase:'saving',editing:false,error:''}); this.saved = null; this.backup = null;
    await this.writes.catch(() => {});
    await this.d.storage.remove(this.d.id).catch(e => this.set({error:String(e)}));
    this.set({phase:'idle'});
  }
  guardSubmit() {
    if (['confirm','recover','saving'].includes(this.state.phase)) throw new Error(this.d.t('message.editFinish'));
    if (this.state.editing && this.d.running()) throw new Error(this.d.t('message.editRunning'));
    for (const a of this.d.conversation.draftImages(this.d.shell.snapshot.imageIds)) {
      if (a.historyRef && a.loadState !== 'ready') throw new Error(this.d.t('message.editMissing'));
    }
  }
  async sent() {
    if (!this.state.editing) return;
    this.set({phase:'saving',editing:false,error:''}); this.backup = null;
    await this.writes.catch(() => {});
    await this.d.storage.remove(this.d.id).catch(e => this.set({error:String(e)}));
    this.set({phase:'idle'});
  }
  dispose() { this.off(); this.disposed = true; this.listeners.clear(); }
}
function xhAttachEditor(hub, id, shell) {

  const editor = new XHarnessMessageEditor({id,shell,get conversation(){return hub.conversation();},storage:xhEditPersistence,t:hub.t,
    running:()=>hub.sessions().list.getSnapshot().byId[id]?.running === true,
    read:attachmentId=>hub.sessions().binding(id).session.readAttachment(attachmentId),
    focus:()=>requestAnimationFrame(()=>{
      const seat = document.querySelector('[data-xh-editor-session="'+CSS.escape(id)+'"]')?.parentElement;
      const input = seat?.querySelector('[data-composer-seat] textarea') || seat?.querySelector('textarea');
      if (input) { input.focus(); input.setSelectionRange(input.value.length,input.value.length); }
    })});
  shell.xhEditor = editor;
  const submit = shell.submit.bind(shell);
  shell.submit = (...args) => { try { editor.guardSubmit(); return submit(...args); } catch(e) {shell.notify('error',String(e));} };
  const sink = shell.deps.defaultSink;
  shell.deps.defaultSink = async (...args) => {
    editor.guardSubmit();
    const editing = editor.state.editing;
    const result = await sink(...args);
    if (editing && result.kind === 'success') await editor.sent();
    return result;
  };
  const dispose = shell.dispose.bind(shell); shell.dispose=()=>{editor.dispose();dispose();};
  return editor;
}
function xhEditMessage(inputHub, sessionId, content) {
  const shell = inputHub.shell(sessionId);
  return shell.xhEditor.request(content).catch(e=>shell.notify('error',String(e)));
}
function XHarnessEditableInputBar(props) {
  const editor = props.keyboard?.xhEditor;
  const state = react.useSyncExternalStore(editor?.subscribe || (()=>()=>{}), editor?.getSnapshot || (()=>null));
  const button = (label, action, disabled=false) => react_jsx_runtime.jsx('button',{type:'button',disabled,onClick:()=>Promise.resolve(action()).catch(e=>editor.set({error:String(e)})),children:props.t(label)});
  const images = editor?.d.conversation.draftImages(editor.d.shell.snapshot.imageIds) || [];
  return react_jsx_runtime.jsxs(react_jsx_runtime.Fragment,{children:[
    react_jsx_runtime.jsxs('div',{'data-xh-editor-session':props.sessionId,style:{fontSize:13,padding:state?.phase !== 'idle' || state?.error ? '8px 12px' : 0},children:[
      state?.phase==='confirm' && react_jsx_runtime.jsxs('div',{role:'alertdialog','aria-label':props.t('message.editReplace'),children:[props.t('message.editReplace'),button('message.editConfirm',()=>editor.confirm()),button('message.editCancel',()=>editor.cancel())]}),
      state?.phase==='recover' && react_jsx_runtime.jsxs('div',{children:[props.t('message.editRecovered'),button('message.editResume',()=>editor.recover()),button('message.editCancel',()=>editor.cancel())]}),
      state?.phase==='saving' && props.t('message.editSaving'),
      state?.editing && react_jsx_runtime.jsxs('div',{children:[props.t('message.editActive'),button('message.editCancel',()=>editor.cancel(),editor.busy())]}),
      state?.error && react_jsx_runtime.jsx('div',{role:'alert',children:state.error}),
      images.filter(a=>a.historyRef && a.loadState!=='ready').map(a=>react_jsx_runtime.jsxs('div',{role:'status',children:[props.t(a.loadState==='loading'?'message.editLoading':'message.editMissing'),' ',a.file.name,
        a.loadState==='missing' && button('message.editRetry',()=>editor.hydrate(a)),button('message.editRemove',()=>props.removeImage(a.id),editor.busy())]},a.id))
    ]}), react_jsx_runtime.jsx(InputBar,{...props,disabled:props.disabled || ['confirm','recover','saving'].includes(state?.phase)})
  ]});
}
function XHarnessEditAction({ content, editMessage, t }) {
  return react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Tooltip,{label:t('message.edit'),side:'bottom',children:
    react_jsx_runtime.jsx('button',{type:'button',className:MessageIconActions_module_css_default.action,'aria-label':t('message.edit'),'data-message-edit':'',onClick:()=>editMessage(content),children:'✎'})});
}
