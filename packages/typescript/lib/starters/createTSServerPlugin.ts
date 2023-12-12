import type * as ts from 'typescript/lib/tsserverlibrary';
import { decorateLanguageService } from '../node/decorateLanguageService';
import { decorateLanguageServiceHost, searchExternalFiles } from '../node/decorateLanguageServiceHost';
import { createFileProvider, LanguagePlugin, resolveCommonLanguageId } from '@volar/language-core';

const externalFiles = new WeakMap<ts.server.Project, string[]>();
const projectExternalFileExtensions = new WeakMap<ts.server.Project, string[]>();

export function createTSServerPlugin(
	init: (
		ts: typeof import('typescript/lib/tsserverlibrary'),
		info: ts.server.PluginCreateInfo
	) => {
		languagePlugins: LanguagePlugin[];
		extensions: string[];
	}
): ts.server.PluginModuleFactory {
	return (modules) => {
		const { typescript: ts } = modules;
		const pluginModule: ts.server.PluginModule = {
			create(info) {
				const { languagePlugins, extensions } = init(ts, info);
				projectExternalFileExtensions.set(info.project, extensions);
				const getScriptSnapshot = info.languageServiceHost.getScriptSnapshot.bind(info.languageServiceHost);
				const files = createFileProvider(
					languagePlugins,
					ts.sys.useCaseSensitiveFileNames,
					fileName => {
						const snapshot = getScriptSnapshot(fileName);
						if (snapshot) {
							files.updateSourceFile(fileName, resolveCommonLanguageId(fileName), snapshot);
						}
						else {
							files.deleteSourceFile(fileName);
						}
					}
				);

				decorateLanguageService(files, info.languageService);
				decorateLanguageServiceHost(files, info.languageServiceHost, ts, extensions);

				return info.languageService;
			},
			getExternalFiles(project, updateLevel = 0) {
				if (
					updateLevel >= (1 satisfies ts.ProgramUpdateLevel.RootNamesAndUpdate)
					|| !externalFiles.has(project)
				) {
					const oldFiles = externalFiles.get(project);
					const newFiles = searchExternalFiles(ts, project, projectExternalFileExtensions.get(project)!);
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

export function arrayItemsEqual(a: string[], b: string[]) {
	if (a.length !== b.length) {
		return false;
	}
	const set = new Set(a);
	for (const file of b) {
		if (!set.has(file)) {
			return false;
		}
	}
	return true;
}
