import { FileMap, Language, LanguagePlugin, createLanguage } from '@volar/language-core';
import type * as ts from 'typescript';
import { resolveFileLanguageId } from '../common';
import { createProxyLanguageService } from '../node/proxyLanguageService';
import { decorateLanguageServiceHost, searchExternalFiles } from '../node/decorateLanguageServiceHost';
import { arrayItemsEqual, decoratedLanguageServiceHosts, decoratedLanguageServices, externalFiles } from './createLanguageServicePlugin';

export function createAsyncLanguageServicePlugin(
	extensions: string[],
	getScriptKindForExtraExtensions: ts.ScriptKind | ((fileName: string) => ts.ScriptKind),
	create: (
		ts: typeof import('typescript'),
		info: ts.server.PluginCreateInfo
	) => Promise<{
		languagePlugins: LanguagePlugin<string>[],
		setup?: (language: Language<string>) => void;
	}>
): ts.server.PluginModuleFactory {
	return modules => {
		const { typescript: ts } = modules;
		const pluginModule: ts.server.PluginModule = {
			create(info) {
				if (
					!decoratedLanguageServices.has(info.languageService)
					&& !decoratedLanguageServiceHosts.has(info.languageServiceHost)
				) {
					decoratedLanguageServices.add(info.languageService);
					decoratedLanguageServiceHosts.add(info.languageServiceHost);

					const emptySnapshot = ts.ScriptSnapshot.fromString('');
					const getScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(info.languageServiceHost);
					const getScriptVersion = info.languageServiceHost.getScriptVersion.bind(info.languageServiceHost);
					const getScriptKind = info.languageServiceHost.getScriptKind?.bind(info.languageServiceHost);
					const getProjectVersion = info.languageServiceHost.getProjectVersion?.bind(info.languageServiceHost);

					let initialized = false;

					info.languageServiceHost.getScriptSnapshot = fileName => {
						if (!initialized && extensions.some(ext => fileName.endsWith(ext))) {
							return emptySnapshot;
						}
						return getScriptSnapshot(fileName);
					};
					info.languageServiceHost.getScriptVersion = fileName => {
						if (!initialized && extensions.some(ext => fileName.endsWith(ext))) {
							return 'initializing...';
						}
						return getScriptVersion(fileName);
					};
					if (getScriptKind) {
						info.languageServiceHost.getScriptKind = fileName => {
							if (!initialized && extensions.some(ext => fileName.endsWith(ext))) {
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
							if (!initialized) {
								return getProjectVersion() + ',initializing...';
							}
							return getProjectVersion();
						};
					}

					const { proxy, initialize } = createProxyLanguageService(info.languageService);
					info.languageService = proxy;

					create(ts, info).then(({ languagePlugins, setup }) => {
						const language = createLanguage<string>(
							[
								...languagePlugins,
								{ getLanguageId: resolveFileLanguageId },
							],
							new FileMap(ts.sys.useCaseSensitiveFileNames),
							fileName => {
								const snapshot = info.project.getScriptInfo(fileName)?.getSnapshot();
								if (snapshot) {
									language.scripts.set(fileName, snapshot);
								}
								else {
									language.scripts.delete(fileName);
								}
							}
						);

						initialize(language);
						decorateLanguageServiceHost(ts, language, info.languageServiceHost);
						setup?.(language);

						if ('markAsDirty' in info.project && typeof info.project.markAsDirty === 'function') {
							info.project.markAsDirty();
						}
						initialized = true;
					});
				}

				return info.languageService;
			},
			getExternalFiles(project, updateLevel = 0) {
				if (
					updateLevel >= (1 satisfies ts.ProgramUpdateLevel.RootNamesAndUpdate)
					|| !externalFiles.has(project)
				) {
					const oldFiles = externalFiles.get(project);
					const newFiles = extensions.length ? searchExternalFiles(ts, project, extensions) : [];
					externalFiles.set(project, newFiles);
					if (oldFiles && !arrayItemsEqual(oldFiles, newFiles)) {
						project.refreshDiagnostics();
					}
				}
				return externalFiles.get(project)!;
			},
		};
		return pluginModule;
	};
}
