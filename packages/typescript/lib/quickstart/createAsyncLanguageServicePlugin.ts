import type * as ts from 'typescript';
import { createProxyLanguageService } from '../node/proxyLanguageService';
import { createLanguageCommon, isHasAlreadyDecoratedLanguageService, makeGetExternalFiles, makeGetScriptInfoWithLargeFileFailsafe } from './languageServicePluginCommon';
import type { createPluginCallbackAsync } from './languageServicePluginCommon';

/**
 * Creates and returns a TS Service Plugin that supports async initialization.
 * Essentially, this functions the same as `createLanguageServicePlugin`, but supports
 * use cases in which the plugin callback must be async. For example in mdx-analyzer
 * and Glint, this async variant is required because Glint + mdx-analyzer are written
 * in ESM and get transpiled to CJS, which requires usage of `await import()` to load
 * the necessary dependencies and fully initialize the plugin.
 *
 * To handle the period of time in which the plugin is initializing, this async
 * variant stubs a number of methods on the LanguageServiceHost to handle the uninitialized state.
 *
 * Additionally, this async variant requires a few extra args pertaining to
 * file extensions intended to be handled by the TS Plugin. In the synchronous variant,
 * these can be synchronously inferred from elsewhere but for the async variant, they
 * need to be passed in.
 *
 * See https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin for
 * more information.
 */
export function createAsyncLanguageServicePlugin(
	extensions: string[],
	getScriptKindForExtraExtensions: ts.ScriptKind | ((fileName: string) => ts.ScriptKind),
	createPluginCallbackAsync: createPluginCallbackAsync
): ts.server.PluginModuleFactory {
	return modules => {
		const { typescript: ts } = modules;

		const pluginModule: ts.server.PluginModule = {
			create(info) {
				if (!isHasAlreadyDecoratedLanguageService(info)) {
					const state = decorateWithAsyncInitializationHandling(ts, info, extensions, getScriptKindForExtraExtensions);

					const { proxy, initialize } = createProxyLanguageService(info.languageService);
					info.languageService = proxy;

					createPluginCallbackAsync(ts, info).then((createPluginResult) => {
						createLanguageCommon(createPluginResult, ts, info, initialize);

						state.initialized = true;

						if ('markAsDirty' in info.project && typeof info.project.markAsDirty === 'function') {
							// This is an attempt to mark the project as dirty so that in case the IDE/tsserver
							// already finished a first pass of generating diagnostics (or other things), another
							// pass will be triggered which should hopefully make use of this now-initialized plugin.
							info.project.markAsDirty();
						}
					});
				}

				return info.languageService;
			},
			getExternalFiles: makeGetExternalFiles(ts),
		};
		return pluginModule;
	};
}

function decorateWithAsyncInitializationHandling(ts: typeof import('typescript'), info: ts.server.PluginCreateInfo, extensions: string[], getScriptKindForExtraExtensions: ts.ScriptKind | ((fileName: string) => ts.ScriptKind)) {
	const emptySnapshot = ts.ScriptSnapshot.fromString('');
	const getScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(info.languageServiceHost);
	const getScriptVersion = info.languageServiceHost.getScriptVersion.bind(info.languageServiceHost);
	const getScriptKind = info.languageServiceHost.getScriptKind?.bind(info.languageServiceHost);
	const getProjectVersion = info.languageServiceHost.getProjectVersion?.bind(info.languageServiceHost);

	const getScriptInfo = makeGetScriptInfoWithLargeFileFailsafe(info);

	const state = { initialized: false };

	info.languageServiceHost.getScriptSnapshot = fileName => {
		if (!state.initialized) {
			if (extensions.some(ext => fileName.endsWith(ext))) {
				return emptySnapshot;
			}
			if (getScriptInfo(fileName)?.isScriptOpen()) {
				return emptySnapshot;
			}
		}
		return getScriptSnapshot(fileName);
	};
	info.languageServiceHost.getScriptVersion = fileName => {
		if (!state.initialized) {
			if (extensions.some(ext => fileName.endsWith(ext))) {
				return 'initializing...';
			}
			if (getScriptInfo(fileName)?.isScriptOpen()) {
				return getScriptVersion(fileName) + ',initializing...';
			}
		}
		return getScriptVersion(fileName);
	};
	if (getScriptKind) {
		info.languageServiceHost.getScriptKind = fileName => {
			if (!state.initialized && extensions.some(ext => fileName.endsWith(ext))) {
				// bypass upstream bug https://github.com/microsoft/TypeScript/issues/57631
				// TODO: check if the bug is fixed in 5.5
				if (typeof getScriptKindForExtraExtensions === 'function') {
					return getScriptKindForExtraExtensions(fileName);
				}
				else {
					return getScriptKindForExtraExtensions;
				}
			}
			return getScriptKind(fileName);
		};
	}
	if (getProjectVersion) {
		info.languageServiceHost.getProjectVersion = () => {
			if (!state.initialized) {
				return getProjectVersion() + ',initializing...';
			}
			return getProjectVersion();
		};
	}

	return state;
}
