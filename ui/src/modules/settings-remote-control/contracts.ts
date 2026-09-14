import type {EffectContext,LocaleService,SlotsService,Translation} from '../shared/runtime-types'
import type {IApiClient} from '../client-connection'
export type Channel = 'telegram'|'feishu'|'lark'|'weixin'|'mobile_web'
export interface Account {channel:Channel;id:string}
export type ConnectionState = {state:'disabled'|'starting'|'online'|'stopped'}|{state:'failed';reason:string}
export interface AccountView {account:Account;enabled:boolean;revision:number;credential_reference_saved:boolean;connection:ConnectionState}
export interface Status {host:string;manager:ConnectionState|{state:'dormant'|'running'};accounts:readonly AccountView[];credential_cleanup_pending:boolean}
export interface Principal {id:string;host:string;sender:{channel:Channel;account:string;user:string};workspaces:readonly string[];sessions:readonly string[];revision:number;revoked:boolean}
export interface Binding {id:string;principal:string;conversation:string;workspace:string;session:string;generation:number}
export interface CreationPolicy {principal:string;principal_revision:number;generation:number;workspaces:readonly string[]}
export interface GrantEntry {principal:Principal;bindings:readonly Binding[];creation_policy?:CreationPolicy}
export interface GrantPage {items:readonly GrantEntry[];next:string|null}
export interface GrantVersion {principal:string;revision:number;binding:string;generation:number}
export interface RecoveryEntry {key:string;sequence:number;account:Account;sender:{channel:Channel;account:string;user:string};principal:string;binding:Binding;failure:string|null;expected_message:string|null}
export interface RecoveryPage {items:readonly RecoveryEntry[];next:number|null}
export interface InboxIdentity {key:string;sequence:number;principal:string;principal_revision:number;binding:Binding;identity_sha256:string}
export type InboxCommand = 'prompt'|'cancel'|'history'|'catalogue'|'select'|'create_session'|'automation_read'|'automation_control'|'answer_interaction'
export interface InboxEntry {identity:InboxIdentity;command:InboxCommand;interaction:'approval'|'question'|null;observed_accepted_allowed:boolean}
export interface InboxPage {items:readonly InboxEntry[];next:number|null}
export type InboxResolution = 'observed_accepted'|'verified_not_applied'|'abandon_without_replay'
export type Action = {type:'status'}|{type:'grants';after?:string}|{type:'configure_telegram';bot_id:string;expected_revision:number;enabled:boolean;token:string}
 |{type:'set_enabled';account:Account;expected_revision:number;enabled:boolean}
 |{type:'grant';account:Account;user:string;workspace:string;session:string;expected?:GrantVersion}
 |{type:'grant_scopes';account:Account;user:string;workspaces:readonly string[];sessions:readonly string[];workspace:string;session:string;create_workspaces:readonly string[];expected_creation_generation:number|null;expected?:GrantVersion}
 |{type:'revoke';principal:string}|{type:'cleanup_credentials'}|{type:'uncertain_replies';after:number}
 |{type:'uncertain_inbox';after:number}|{type:'resolve_inbox';expected:InboxIdentity;evidence_sha256:string;resolution:InboxResolution}
 |{type:'resolve_reply';key:string;evidence_sha256:string;resolution:{type:'verified_not_sent'|'abandon_without_replay'}|{type:'observed_delivered';receipt:{message_id:string}}}
export interface Catalog {workspaces:readonly {id:string;title:string;sessions:readonly string[]}[];sessions:Readonly<Record<string,string>>}
export interface SettingsRemoteContext extends EffectContext {slots:SlotsService;locale:LocaleService;get(name:'connection'):{api:IApiClient;isLoopback:boolean}}
export interface RemoteSettingsProps {t:Translation;local:boolean;api:RemoteAdminClient;catalog:()=>Promise<Catalog>}
export interface RemoteAdminClient {status():Promise<Status>;grants(after?:string):Promise<GrantPage>;recovery(after?:number):Promise<RecoveryPage>;inboxRecovery(after?:number):Promise<InboxPage>;mutate(action:Exclude<Action,{type:'status'|'grants'|'uncertain_replies'|'uncertain_inbox'}>):Promise<void>}
