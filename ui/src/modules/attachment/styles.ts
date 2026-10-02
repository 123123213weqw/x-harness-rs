import AttachmentRailStyles from './AttachmentRail.css'
import DropOverlayStyles from './DropOverlay.css'
import ImageLightboxStyles from './ImageLightbox.css'
import ComposerAttachmentsStyles from './ComposerAttachments.css'
import MessageImageStyles from './MessageImage.css'
import fileStyles from './FileCard.css'
export const AttachmentRailCss = {
			"arrow": "sfWyaW_arrow",
			"arrowLeft": "sfWyaW_arrowLeft",
			"arrowRight": "sfWyaW_arrowRight",
			"item": "sfWyaW_item",
			"rail": "sfWyaW_rail",
			"remove": "sfWyaW_remove",
			"root": "sfWyaW_root",
			"thumbnail": "sfWyaW_thumbnail"
		}
export const DropOverlayCss = {
			"desc": "VhJ6zG_desc",
			"fade-in": "VhJ6zG_fade-in",
			"illustration": "VhJ6zG_illustration",
			"mask": "VhJ6zG_mask",
			"title": "VhJ6zG_title",
			"wrap": "VhJ6zG_wrap"
		}
export const ImageLightboxCss = {
			"backdrop": "Yq4GiW_backdrop",
			"close": "Yq4GiW_close",
			"image": "Yq4GiW_image",
			"mask": "Yq4GiW_mask"
		}
export const ComposerAttachmentsCss = { "rail": "ArGB1q_rail" }
export const MessageImageCss = {
			"error": "_0TeX1a_error",
			"frame": "_0TeX1a_frame",
			"gallery": "_0TeX1a_gallery",
			"loading": "_0TeX1a_loading"
		}
/** Preserve the current distribution's stylesheet cascade order. */
function injectCss(tagId: string | undefined, css: string): void {
  if (typeof document === 'undefined') return
  if (tagId !== undefined && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
  const tag = document.createElement('style')
  if (tagId !== undefined) { tag.dataset.plugin = '@xharness/dsh-client-ui-attachment'; tag.dataset.pluginCss = tagId }
  tag.textContent = css
  document.head.appendChild(tag)
}
injectCss('@xharness/dsh-client-ui-attachment/AttachmentRail.module.css', AttachmentRailStyles)
injectCss('@xharness/dsh-client-ui-attachment/DropOverlay.module.css', DropOverlayStyles)
injectCss('@xharness/dsh-client-ui-attachment/ImageLightbox.module.css', ImageLightboxStyles)
injectCss('@xharness/dsh-client-ui-attachment/ComposerAttachments.module.css', ComposerAttachmentsStyles)
injectCss(undefined, fileStyles)
injectCss('@xharness/dsh-client-ui-attachment/MessageImage.module.css', MessageImageStyles)
