import { useSyncExternalStore } from 'react'
import type { ComposerBarProps } from '../contract/slots'
import { InputBar } from '../skeleton/InputBar'
const ABSENT_EDITOR = { subscribe: (): (() => void) => () => {}, getSnapshot: () => null }
export function XHarnessEditableInputBar(props: ComposerBarProps) {
 const editor = props.keyboard?.xhEditor, state = useSyncExternalStore(editor?.subscribe ?? ABSENT_EDITOR.subscribe, editor?.getSnapshot ?? ABSENT_EDITOR.getSnapshot)
 const button = (label: Parameters<typeof props.t>[0], action: () => void | Promise<void>, disabled = false) => <button type="button" disabled={disabled} onClick={() => { void Promise.resolve(action()).catch((error: unknown) => editor?.set({ error: String(error) })) }}>{props.t(label)}</button>
 const images = editor?.d.conversation.draftImages(editor.d.shell.snapshot.imageIds) ?? []
 const editingLocked = state?.phase === 'confirm' || state?.phase === 'recover' || state?.phase === 'saving'
 return <>
  <div data-xh-editor-session={props.sessionId} style={{ fontSize: 13, padding: state?.phase !== 'idle' || state?.error ? '8px 12px' : 0 }}>
   {state?.phase === 'confirm' && <div role="alertdialog" aria-label={props.t('message.editReplace')}>{props.t('message.editReplace')}{button('message.editConfirm', () => editor?.confirm())}{button('message.editCancel', () => editor?.cancel())}</div>}
   {state?.phase === 'recover' && <div>{props.t('message.editRecovered')}{button('message.editResume', () => editor?.recover())}{button('message.editCancel', () => editor?.cancel())}</div>}
   {state?.phase === 'saving' && props.t('message.editSaving')}
   {state?.editing && <div>{props.t('message.editActive')}{button('message.editCancel', () => editor?.cancel(), editor?.busy())}</div>}
   {state?.error && <div role="alert">{state.error}</div>}
   {images.filter(image => image.historyRef && image.loadState !== 'ready').map(image => <div key={image.id} role="status">{props.t(image.loadState === 'loading' ? 'message.editLoading' : 'message.editMissing')} {image.file.name}
    {image.loadState === 'missing' && button('message.editRetry', () => editor?.hydrate(image))}{button('message.editRemove', () => props.removeImage?.(image.id), editor?.busy())}
   </div>)}
  </div>
  <InputBar {...props} disabled={props.disabled || editingLocked} />
 </>
}
