import ModelsSectionStyles from './ModelsSection.css'
import OnboardingModalStyles from './OnboardingModal.css'
import DeepSeekOnboardingDialogStyles from './DeepSeekOnboardingDialog.css'
import WelcomeNoticeStyles from './WelcomeNotice.css'
export const ModelsSectionCss = {
			"addActions": "HGcBra_addActions",
			"addBlock": "HGcBra_addBlock",
			"addButton": "HGcBra_addButton",
			"addCard": "HGcBra_addCard",
			"addModelButton": "HGcBra_addModelButton",
			"advancedHint": "HGcBra_advancedHint",
			"candidate": "HGcBra_candidate",
			"candidateActions": "HGcBra_candidateActions",
			"candidateId": "HGcBra_candidateId",
			"candidateLabel": "HGcBra_candidateLabel",
			"candidateList": "HGcBra_candidateList",
			"credentialDot": "HGcBra_credentialDot",
			"credentialDotConfigured": "HGcBra_credentialDotConfigured",
			"credentialDotMissing": "HGcBra_credentialDotMissing",
			"customized": "HGcBra_customized",
			"customizedBody": "HGcBra_customizedBody",
			"customizedSummary": "HGcBra_customizedSummary",
			"dangerButton": "HGcBra_dangerButton",
			"deleteConfirm": "HGcBra_deleteConfirm",
			"deleteDialog": "HGcBra_deleteDialog",
			"editor": "HGcBra_editor",
			"editorActions": "HGcBra_editorActions",
			"editorHeader": "HGcBra_editorHeader",
			"editorRoute": "HGcBra_editorRoute",
			"editorTitle": "HGcBra_editorTitle",
			"error": "HGcBra_error",
			"fetchDialog": "HGcBra_fetchDialog",
			"field": "HGcBra_field",
			"fieldLabel": "HGcBra_fieldLabel",
			"hiddenLabel": "HGcBra_hiddenLabel",
			"iconButton": "HGcBra_iconButton",
			"iconButtonDanger": "HGcBra_iconButtonDanger",
			"input": "HGcBra_input",
			"intro": "HGcBra_intro",
			"linkButton": "HGcBra_linkButton",
			"modelAdvanced": "HGcBra_modelAdvanced",
			"modelCatalog": "HGcBra_modelCatalog",
			"modelCatalogHeading": "HGcBra_modelCatalogHeading",
			"modelCatalogMeta": "HGcBra_modelCatalogMeta",
			"modelCatalogTitle": "HGcBra_modelCatalogTitle",
			"modelEmpty": "HGcBra_modelEmpty",
			"modelEntry": "HGcBra_modelEntry",
			"modelField": "HGcBra_modelField",
			"modelFieldLabel": "HGcBra_modelFieldLabel",
			"modelList": "HGcBra_modelList",
			"modelListHead": "HGcBra_modelListHead",
			"modelRow": "HGcBra_modelRow",
			"notice": "HGcBra_notice",
			"primaryButton": "HGcBra_primaryButton",
			"rowActions": "HGcBra_rowActions",
			"rowCard": "HGcBra_rowCard",
			"rowHead": "HGcBra_rowHead",
			"rowIdentity": "HGcBra_rowIdentity",
			"rowName": "HGcBra_rowName",
			"rowTag": "HGcBra_rowTag",
			"rows": "HGcBra_rows",
			"savedNotice": "HGcBra_savedNotice",
			"secondaryButton": "HGcBra_secondaryButton",
			"section": "HGcBra_section",
			"selectInput": "HGcBra_selectInput",
			"setupCard": "HGcBra_setupCard",
			"title": "HGcBra_title"
		}
export const OnboardingModalCss = {
			"body": "_5TDjIa_body",
			"content": "_5TDjIa_content",
			"dialog": "_5TDjIa_dialog",
			"title": "_5TDjIa_title"
		}
export const DeepSeekOnboardingDialogCss = {
			"description": "_2WZCNq_description",
			"editor": "_2WZCNq_editor"
		}
export const WelcomeNoticeCss = {
			"actions": "tKGJdq_actions",
			"copy": "tKGJdq_copy",
			"error": "tKGJdq_error",
			"primary": "tKGJdq_primary"
		}
for(const [tagId, css] of [['@xharness/dsh-client-ui-settings-models/ModelsSection.module.css', ModelsSectionStyles],
['@xharness/dsh-client-ui-settings-models/OnboardingModal.module.css', OnboardingModalStyles],
['@xharness/dsh-client-ui-settings-models/DeepSeekOnboardingDialog.module.css', DeepSeekOnboardingDialogStyles],
['@xharness/dsh-client-ui-settings-models/WelcomeNotice.module.css', WelcomeNoticeStyles]] as const) {
 if(typeof document !== 'undefined' && document.querySelector('style[data-plugin-css='+JSON.stringify(tagId)+']')===null) {
 const tag=document.createElement('style');tag.dataset.plugin='@xharness/dsh-client-ui-settings-models';tag.dataset.pluginCss=tagId;tag.textContent=css;document.head.appendChild(tag)
 }
}
