// Generated from ui/src/plugin-api/client.ts; do not edit.
window.__ModuleLoader__.load({
  id: '@xlang/xharness-client-plugin-api',
  factory: () => {
    const exports = {};
    "use strict";
    Object.defineProperty(exports, "__esModule", { value: true });
    exports.WIRE_FIELDS = exports.inject = exports.PluginTransportError = exports.PluginRemoteError = exports.PluginProtocolError = void 0;
    exports.errorMessage = errorMessage;
    exports.isUnsupportedEndpoint = isUnsupportedEndpoint;
    exports.decodeResponse = decodeResponse;
    exports.createPluginClient = createPluginClient;
    exports.apply = apply;
    class PluginProtocolError extends Error {
        constructor(endpoint, field) {
            // Never interpolate response values (possibly credentials/HTML) into errors.
            super(`Invalid plugin response: ${endpoint} (${field})`);
            this.endpoint = endpoint;
            this.field = field;
            this.kind = 'protocol';
            this.name = 'PluginProtocolError';
        }
    }
    exports.PluginProtocolError = PluginProtocolError;
    class PluginRemoteError extends Error {
        constructor(endpoint, code, message, details) {
            super(message);
            this.endpoint = endpoint;
            this.code = code;
            this.details = details;
            this.kind = 'remote';
            this.name = 'PluginRemoteError';
        }
    }
    exports.PluginRemoteError = PluginRemoteError;
    class PluginTransportError extends Error {
        constructor(endpoint, cause) {
            super(`Plugin request failed: ${endpoint}: ${errorMessage(cause)}`);
            this.endpoint = endpoint;
            this.cause = cause;
            this.kind = 'transport';
            this.name = 'PluginTransportError';
        }
    }
    exports.PluginTransportError = PluginTransportError;
    function errorMessage(error) {
        return error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unknown plugin error';
    }
    function isUnsupportedEndpoint(error, endpoint) {
        return error instanceof PluginRemoteError && error.endpoint === endpoint
            && error.code === 'bad-request' && error.message === `unsupported plugin endpoint ${endpoint}`;
    }
    function isObjectRecord(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }
    function object(value, endpoint, field) {
        if (!isObjectRecord(value))
            throw new PluginProtocolError(endpoint, field);
        return value;
    }
    function text(value, endpoint, field) {
        if (typeof value !== 'string')
            throw new PluginProtocolError(endpoint, field);
        return value;
    }
    function bool(value, endpoint, field) {
        if (typeof value !== 'boolean')
            throw new PluginProtocolError(endpoint, field);
        return value;
    }
    function nullableText(value, endpoint, field) {
        return value === null ? null : text(value, endpoint, field);
    }
    function array(value, endpoint, field, parse) {
        if (!Array.isArray(value))
            throw new PluginProtocolError(endpoint, field);
        return value.map((item, index) => parse(item, `${field}[${index}]`));
    }
    function strings(value, endpoint, field) {
        return array(value, endpoint, field, (item, path) => text(item, endpoint, path));
    }
    function source(value, endpoint, field) {
        const v = object(value, endpoint, field);
        return {
            source: text(v.source, endpoint, `${field}.source`), type: text(v.type, endpoint, `${field}.type`),
            url: text(v.url, endpoint, `${field}.url`), sha256: text(v.sha256, endpoint, `${field}.sha256`),
        };
    }
    function catalog(value, endpoint, field) {
        const v = object(value, endpoint, field);
        const localized = v.descriptionI18n === undefined ? {} : object(v.descriptionI18n, endpoint, `${field}.descriptionI18n`);
        // Own property construction; __proto__ from JSON must not mutate a prototype.
        const descriptionI18n = Object.fromEntries(Object.entries(localized).map(([key, val]) => [key, text(val, endpoint, `${field}.descriptionI18n`)]));
        return {
            name: text(v.name, endpoint, `${field}.name`), scope: v.scope === undefined ? 'public' : text(v.scope, endpoint, `${field}.scope`),
            description: v.description === undefined ? '' : text(v.description, endpoint, `${field}.description`),
            descriptionI18n, version: v.version === undefined ? '' : text(v.version, endpoint, `${field}.version`),
            category: v.category === undefined ? '' : text(v.category, endpoint, `${field}.category`),
            icon: v.icon === undefined ? null : nullableText(v.icon, endpoint, `${field}.icon`), source: source(v.source, endpoint, `${field}.source`),
        };
    }
    function skill(value, endpoint, field) {
        const v = object(value, endpoint, field);
        return { name: text(v.name, endpoint, `${field}.name`), description: text(v.description, endpoint, `${field}.description`),
            relativePath: text(v.relativePath, endpoint, `${field}.relativePath`), sha256: text(v.sha256, endpoint, `${field}.sha256`) };
    }
    function installed(value, endpoint, field) {
        const v = object(value, endpoint, field);
        return {
            name: text(v.name, endpoint, `${field}.name`), version: text(v.version, endpoint, `${field}.version`),
            description: text(v.description, endpoint, `${field}.description`), digest: text(v.digest, endpoint, `${field}.digest`),
            enabled: bool(v.enabled, endpoint, `${field}.enabled`),
            mcpEnabled: v.mcpEnabled === undefined ? false : bool(v.mcpEnabled, endpoint, `${field}.mcpEnabled`),
            mcpConfigSha256: v.mcpConfigSha256 === undefined ? null : nullableText(v.mcpConfigSha256, endpoint, `${field}.mcpConfigSha256`),
            capabilities: strings(v.capabilities, endpoint, `${field}.capabilities`),
            skills: array(v.skills, endpoint, `${field}.skills`, (item, path) => skill(item, endpoint, path)),
        };
    }
    function update(value, endpoint, field) {
        const v = object(value, endpoint, field);
        return { name: text(v.name, endpoint, `${field}.name`), installedVersion: text(v.installedVersion, endpoint, `${field}.installedVersion`),
            availableVersion: text(v.availableVersion, endpoint, `${field}.availableVersion`), availableDigest: text(v.availableDigest, endpoint, `${field}.availableDigest`) };
    }
    function preview(value, endpoint, field) {
        const v = object(value, endpoint, field);
        return { server: text(v.server, endpoint, `${field}.server`), command: text(v.command, endpoint, `${field}.command`),
            args: strings(v.args, endpoint, `${field}.args`), envKeys: strings(v.envKeys, endpoint, `${field}.envKeys`),
            envSources: Object.fromEntries(Object.entries(v.envSources === undefined ? {} : object(v.envSources, endpoint, `${field}.envSources`))
                .map(([key, source]) => [key, text(source, endpoint, `${field}.envSources.${key}`)])) };
    }
    function parseCatalogs(v, endpoint) {
        return array(v.plugins, endpoint, 'plugins', (item, path) => catalog(item, endpoint, path));
    }
    function parsePlugin(v, endpoint) {
        return { plugin: installed(v.plugin, endpoint, 'plugin') };
    }
    // The indexed mapped type preserves endpoint/result correlation statically;
    // every parser still validates its actual payload at runtime before returning.
    const payloadDecoders = {
        'plugins/catalog': v => ({
            plugins: parseCatalogs(v, 'plugins/catalog'),
        }),
        'plugins/importCatalog': v => ({ plugins: parseCatalogs(v, 'plugins/importCatalog') }),
        'plugins/installed': v => ({ plugins: array(v.plugins, 'plugins/installed', 'plugins', (item, path) => installed(item, 'plugins/installed', path)) }),
        'plugins/updates': v => ({ updates: array(v.updates, 'plugins/updates', 'updates', (item, path) => update(item, 'plugins/updates', path)) }),
        'plugins/mcpPreview': v => ({ servers: array(v.servers, 'plugins/mcpPreview', 'servers', (item, path) => preview(item, 'plugins/mcpPreview', path)) }),
        'plugins/uninstall': v => {
            if (v.ok !== true)
                throw new PluginProtocolError('plugins/uninstall', 'ok');
            return { ok: true };
        },
        'plugins/install': v => parsePlugin(v, 'plugins/install'),
        'plugins/enable': v => parsePlugin(v, 'plugins/enable'),
        'plugins/disable': v => parsePlugin(v, 'plugins/disable'),
        'plugins/mcpEnable': v => parsePlugin(v, 'plugins/mcpEnable'),
        'plugins/mcpDisable': v => parsePlugin(v, 'plugins/mcpDisable'),
    };
    function decodeResponse(endpoint, input) {
        const envelope = object(input, endpoint, 'result');
        const ok = bool(envelope.ok, endpoint, 'result.ok');
        if (!ok) {
            if ('value' in envelope)
                throw new PluginProtocolError(endpoint, 'failed result contains value');
            const error = object(envelope.error, endpoint, 'result.error');
            throw new PluginRemoteError(endpoint, text(error.code, endpoint, 'result.error.code'), text(error.message, endpoint, 'result.error.message'), error.details);
        }
        if ('error' in envelope)
            throw new PluginProtocolError(endpoint, 'successful result contains error');
        const v = object(envelope.value, endpoint, 'result.value');
        if (!Object.prototype.hasOwnProperty.call(payloadDecoders, endpoint))
            throw new PluginProtocolError(endpoint, 'unsupported endpoint');
        return payloadDecoders[endpoint](v);
    }
    function validateArgs(endpoint, input) {
        const args = object(input, endpoint, 'args');
        switch (endpoint) {
            case 'plugins/catalog':
            case 'plugins/installed':
            case 'plugins/updates': return args;
            case 'plugins/importCatalog':
                text(args.content, endpoint, 'args.content');
                if (args.scope !== undefined && args.scope !== 'public' && args.scope !== 'personal')
                    throw new PluginProtocolError(endpoint, 'args.scope');
                return args;
            case 'plugins/install':
            case 'plugins/enable':
            case 'plugins/disable':
            case 'plugins/uninstall':
            case 'plugins/mcpPreview':
            case 'plugins/mcpEnable':
            case 'plugins/mcpDisable':
                if (!text(args.name, endpoint, 'args.name').trim())
                    throw new PluginProtocolError(endpoint, 'args.name');
                return args;
            default: throw new PluginProtocolError(endpoint, 'unsupported endpoint');
        }
    }
    function createPluginClient(transport) {
        return async (endpoint, ...args) => {
            const payload = { args: validateArgs(endpoint, args[0] ?? {}) };
            let response;
            try {
                response = await transport.call('/api', endpoint, payload);
            }
            catch (cause) {
                throw new PluginTransportError(endpoint, cause);
            }
            // No automatic retries: mutations may already have happened on the Host.
            return decodeResponse(endpoint, response);
        };
    }
    /** Cordis accepts the module as a no-op plugin; helpers are factory exports. */
    function apply() { }
    exports.inject = [];
    /** CI compares these type-checked field sets with real serde output. Production
     * decoding tolerates added fields; CI requires consciously updating the contract.
     */
    exports.WIRE_FIELDS = {
        catalog: { name: true, scope: true, description: true, descriptionI18n: true, version: true, category: true, icon: true, source: true },
        source: { source: true, type: true, url: true, sha256: true },
        skill: { name: true, description: true, relativePath: true, sha256: true },
        installed: { name: true, version: true, description: true, digest: true, enabled: true, mcpEnabled: true, mcpConfigSha256: true, capabilities: true, skills: true },
        update: { name: true, installedVersion: true, availableVersion: true, availableDigest: true },
        preview: { server: true, command: true, args: true, envKeys: true, envSources: true },
    };
    
    return exports;
  },
});
