import type * as ts from 'typescript';
import { createProxyLanguageService } from '../node/proxyLanguageService';
import { createLanguageCommon, isHasAlreadyDecoratedLanguageService, makeGetExternalFiles, projectExternalFileExtensions } from './languageServicePluginCommon';
import type { createPluginCallbackSync } from './languageServicePluginCommon';

/**
 * Creates and returns a TS Service Plugin using Volar primitives.
 *
 * See https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin for
 * more information.
 */
export function createLanguageServicePlugin(
	createPluginCallback: createPluginCallbackSync
): ts.server.PluginModuleFactory {
	return modules => {
		const { typescript: ts } = modules;

		const pluginModule: ts.server.PluginModule = {
			create(info) {
				if (!isHasAlreadyDecoratedLanguageService(info)) {
					const createPluginResult = createPluginCallback(ts, info);
					const extensions = createPluginResult.languagePlugins
						.map(plugin => plugin.typescript?.extraFileExtensions.map(ext => '.' + ext.extension) ?? [])
						.flat();

					// TODO: this logic does not seem to appear in the async variant
					// (createAsyncLanguageServicePlugin)... bug?
					projectExternalFileExtensions.set(info.project, extensions);

					const { proxy, initialize } = createProxyLanguageService(info.languageService);
					info.languageService = proxy;

					createLanguageCommon(createPluginResult, ts, info, initialize);
				}

				return info.languageService;
			},
			getExternalFiles: makeGetExternalFiles(ts),
		};
		return pluginModule;
	};
}
