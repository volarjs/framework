import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { DiagnosticModel, InitializationOptions, LanguageServerPlugin, ServerMode } from '../types';
import { createDocuments } from './documents';
import { ServerContext } from './server';
import { isFileInDir } from './utils/isFileInDir';
import * as path from 'path-browserify';

import type * as _ from 'vscode-languageserver-textdocument';
import { createTypeScriptProject } from './project';
import { getInferredCompilerOptions } from './utils/inferredCompilerOptions';
import { createUriMap } from './utils/uriMap';
import { FileType } from '@volar/language-service';

export const rootTsConfigNames = ['tsconfig.json', 'jsconfig.json'];

export interface WorkspacesContext extends ServerContext {
	workspaces: {
		initParams: vscode.InitializeParams;
		initOptions: InitializationOptions;
		plugins: ReturnType<LanguageServerPlugin>[];
		ts: typeof import('typescript/lib/tsserverlibrary') | undefined;
		tsLocalized: ts.MapLike<string> | undefined;
		documents: ReturnType<typeof createDocuments>;
	};
}

export interface Workspaces extends ReturnType<typeof createWorkspaces> { }

export function createWorkspaces(context: WorkspacesContext, rootUris: URI[]) {

	const { fileNameToUri, uriToFileName, fs } = context.server.runtimeEnv;
	const configProjects = createUriMap<ReturnType<typeof createTypeScriptProject>>(fileNameToUri);
	const inferredProjects = createUriMap<ReturnType<typeof createTypeScriptProject>>(fileNameToUri);
	const rootTsConfigs = new Set<string>();
	const searchedDirs = new Set<string>();

	let semanticTokensReq = 0;
	let documentUpdatedReq = 0;

	context.workspaces.documents.onDidChangeContent(({ textDocument }) => {
		updateDiagnostics(textDocument.uri);
	});
	context.workspaces.documents.onDidClose(({ textDocument }) => {
		context.server.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
	});
	context.server.onDidChangeWatchedFiles(({ changes }) => {
		const tsConfigChanges = changes.filter(change => rootTsConfigNames.includes(change.uri.substring(change.uri.lastIndexOf('/') + 1)));

		for (const change of tsConfigChanges) {
			if (change.type === vscode.FileChangeType.Created) {
				rootTsConfigs.add(uriToFileName(change.uri));
			}
			else if ((change.type === vscode.FileChangeType.Changed || change.type === vscode.FileChangeType.Deleted) && configProjects.uriHas(change.uri)) {
				if (change.type === vscode.FileChangeType.Deleted) {
					rootTsConfigs.delete(uriToFileName(change.uri));
				}
				const project = configProjects.uriGet(change.uri);
				configProjects.uriDelete(change.uri);
				project?.then(project => project.dispose());
			}
		}

		if (tsConfigChanges.length) {
			reloadDiagnostics();
		}
		else {
			updateDiagnosticsAndSemanticTokens();
		}
	});

	context.server.configurationHost?.onDidChangeConfiguration?.(updateDiagnosticsAndSemanticTokens);

	return {
		configProjects,
		inferredProjects,
		getProject,
		reloadProjects: reloadProject,
		add: (rootUri: URI) => {
			if (!rootUris.some(uri => uri.toString() === rootUri.toString())) {
				rootUris.push(rootUri);
			}
		},
		remove: (rootUri: URI) => {
			rootUris = rootUris.filter(uri => uri.toString() !== rootUri.toString());
			for (const uri of configProjects.uriKeys()) {
				const project = configProjects.uriGet(uri)!;
				project.then(project => {
					if (project.context.project.workspaceUri.toString() === rootUri.toString()) {
						configProjects.uriDelete(uri);
						project.dispose();
					}
				});
			}
		},
	};

	async function reloadProject() {

		for (const project of [...configProjects.values(), ...inferredProjects.values()]) {
			project.then(project => project.dispose());
		}

		configProjects.clear();
		inferredProjects.clear();

		reloadDiagnostics();
	}

	function reloadDiagnostics() {
		for (const doc of context.workspaces.documents.data.values()) {
			context.server.connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
		}

		updateDiagnosticsAndSemanticTokens();
	}

	async function updateDiagnosticsAndSemanticTokens() {

		const req = ++semanticTokensReq;

		await updateDiagnostics();

		const delay = 250;
		await sleep(delay);

		if (req === semanticTokensReq) {
			if (context.workspaces.initParams.capabilities.workspace?.semanticTokens?.refreshSupport) {
				context.server.connection.languages.semanticTokens.refresh();
			}
			if (context.workspaces.initParams.capabilities.workspace?.inlayHint?.refreshSupport) {
				context.server.connection.languages.inlayHint.refresh();
			}
			if ((context.workspaces.initOptions.diagnosticModel ?? DiagnosticModel.Push) === DiagnosticModel.Pull) {
				if (context.workspaces.initParams.capabilities.workspace?.diagnostics?.refreshSupport) {
					context.server.connection.languages.diagnostics.refresh();
				}
			}
		}
	}

	async function updateDiagnostics(docUri?: string) {

		if ((context.workspaces.initOptions.diagnosticModel ?? DiagnosticModel.Push) !== DiagnosticModel.Push)
			return;

		const req = ++documentUpdatedReq;
		const delay = 250;
		const cancel = context.server.runtimeEnv.getCancellationToken({
			get isCancellationRequested() {
				return req !== documentUpdatedReq;
			},
			onCancellationRequested: vscode.Event.None,
		});
		const changeDoc = docUri ? context.workspaces.documents.data.uriGet(docUri) : undefined;
		const otherDocs = [...context.workspaces.documents.data.values()].filter(doc => doc !== changeDoc);

		if (changeDoc) {
			await sleep(delay);
			if (cancel.isCancellationRequested) {
				return;
			}
			await sendDocumentDiagnostics(changeDoc.uri, changeDoc.version, cancel);
		}

		for (const doc of otherDocs) {
			await sleep(delay);
			if (cancel.isCancellationRequested) {
				break;
			}
			await sendDocumentDiagnostics(doc.uri, doc.version, cancel);
		}
	}

	async function sendDocumentDiagnostics(uri: string, version: number, cancel: vscode.CancellationToken) {

		const project = await getProject(uri);

		// fix https://github.com/vuejs/language-tools/issues/2627
		if (context.workspaces.initOptions.serverMode === ServerMode.Syntactic) {
			return;
		}
		// const mode = context.initOptions.serverMode === ServerMode.PartialSemantic ? 'semantic' as const
		// 	: context.initOptions.serverMode === ServerMode.Syntactic ? 'syntactic' as const
		// 		: 'all' as const;

		const languageService = project.getLanguageService();
		const errors = await languageService.doValidation(uri, 'all', cancel, result => {
			context.server.connection.sendDiagnostics({ uri: uri, diagnostics: result, version });
		});

		context.server.connection.sendDiagnostics({ uri: uri, diagnostics: errors, version });
	}

	async function getProject(uri: string) {

		if (context.workspaces.initOptions.serverMode !== ServerMode.Syntactic) {
			const tsconfig = await findMatchTSConfig(URI.parse(uri));
			if (tsconfig) {
				return await getOrCreateProject(tsconfig);
			}
		}

		const workspaceUri = getWorkspaceUri(URI.parse(uri));

		if (!inferredProjects.uriHas(workspaceUri.toString())) {
			inferredProjects.uriSet(workspaceUri.toString(), (async () => {
				const inferOptions = await getInferredCompilerOptions(context.server.configurationHost);
				return createTypeScriptProject({
					...context,
					project: {
						workspaceUri,
						rootUri: workspaceUri,
						tsConfig: inferOptions,
					},
				});
			})());
		}

		const project = await inferredProjects.uriGet(workspaceUri.toString())!;

		project.tryAddFile(uriToFileName(uri));

		return project;
	}

	function getWorkspaceUri(uri: URI) {

		const fileName = uriToFileName(uri.toString());

		let _rootUris = [...rootUris]
			.filter(rootUri => isFileInDir(fileName, uriToFileName(rootUri.toString())))
			.sort((a, b) => sortTSConfigs(fileName, uriToFileName(a.toString()), uriToFileName(b.toString())));

		if (!_rootUris.length) {
			_rootUris = [...rootUris];
		}

		if (!_rootUris.length) {
			_rootUris = [uri.with({ path: '/' })];
		}

		return _rootUris[0];
	}

	async function findMatchTSConfig(uri: URI) {

		const filePath = uriToFileName(uri.toString());
		let dir = path.dirname(filePath);

		while (true) {
			if (searchedDirs.has(dir)) {
				break;
			}
			searchedDirs.add(dir);
			for (const tsConfigName of rootTsConfigNames) {
				const tsconfigPath = path.join(dir, tsConfigName);
				if ((await fs.stat?.(fileNameToUri(tsconfigPath)))?.type === FileType.File) {
					rootTsConfigs.add(tsconfigPath);
				}
			}
			dir = path.dirname(dir);
		}

		await prepareClosestootParsedCommandLine();

		return await findDirectIncludeTsconfig() ?? await findIndirectReferenceTsconfig();

		async function prepareClosestootParsedCommandLine() {

			let matches: string[] = [];

			for (const rootTsConfig of rootTsConfigs) {
				if (isFileInDir(uriToFileName(uri.toString()), path.dirname(rootTsConfig))) {
					matches.push(rootTsConfig);
				}
			}

			matches = matches.sort((a, b) => sortTSConfigs(uriToFileName(uri.toString()), a, b));

			if (matches.length) {
				await getParsedCommandLine(matches[0]);
			}
		}
		function findIndirectReferenceTsconfig() {
			return findTSConfig(async tsconfig => {
				const project = await configProjects.pathGet(tsconfig);
				return project?.askedFiles.uriHas(uri.toString()) ?? false;
			});
		}
		function findDirectIncludeTsconfig() {
			return findTSConfig(async tsconfig => {
				const map = createUriMap<boolean>(fileNameToUri);
				const parsedCommandLine = await getParsedCommandLine(tsconfig);
				for (const fileName of parsedCommandLine?.fileNames ?? []) {
					map.pathSet(fileName, true);
				}
				return map.uriHas(uri.toString());
			});
		}
		async function findTSConfig(match: (tsconfig: string) => Promise<boolean> | boolean) {

			const checked = new Set<string>();

			for (const rootTsConfig of [...rootTsConfigs].sort((a, b) => sortTSConfigs(uriToFileName(uri.toString()), a, b))) {
				const project = await configProjects.pathGet(rootTsConfig);
				if (project) {

					let chains = await getReferencesChains(project.getParsedCommandLine(), rootTsConfig, []);

					if (context.workspaces.initOptions.reverseConfigFilePriority) {
						chains = chains.reverse();
					}

					for (const chain of chains) {
						for (let i = chain.length - 1; i >= 0; i--) {
							const tsconfig = chain[i];

							if (checked.has(tsconfig))
								continue;
							checked.add(tsconfig);

							if (await match(tsconfig)) {
								return tsconfig;
							}
						}
					}
				}
			}
		}
		async function getReferencesChains(parsedCommandLine: ts.ParsedCommandLine, tsConfig: string, before: string[]) {

			if (parsedCommandLine.projectReferences?.length) {

				const newChains: string[][] = [];

				for (const projectReference of parsedCommandLine.projectReferences) {

					let tsConfigPath = projectReference.path.replace(/\\/g, '/');

					// fix https://github.com/johnsoncodehk/volar/issues/712
					if ((await fs.stat?.(fileNameToUri(tsConfigPath)))?.type === FileType.File) {
						const newTsConfigPath = path.join(tsConfigPath, 'tsconfig.json');
						const newJsConfigPath = path.join(tsConfigPath, 'jsconfig.json');
						if ((await fs.stat?.(fileNameToUri(newTsConfigPath)))?.type === FileType.File) {
							tsConfigPath = newTsConfigPath;
						}
						else if ((await fs.stat?.(fileNameToUri(newJsConfigPath)))?.type === FileType.File) {
							tsConfigPath = newJsConfigPath;
						}
					}

					const beforeIndex = before.indexOf(tsConfigPath); // cycle
					if (beforeIndex >= 0) {
						newChains.push(before.slice(0, Math.max(beforeIndex, 1)));
					}
					else {
						const referenceParsedCommandLine = await getParsedCommandLine(tsConfigPath);
						if (referenceParsedCommandLine) {
							for (const chain of await getReferencesChains(referenceParsedCommandLine, tsConfigPath, [...before, tsConfig])) {
								newChains.push(chain);
							}
						}
					}
				}

				return newChains;
			}
			else {
				return [[...before, tsConfig]];
			}
		}
		async function getParsedCommandLine(tsConfig: string) {
			const project = await getOrCreateProject(tsConfig);
			return project?.getParsedCommandLine();
		}
	}

	function getOrCreateProject(_tsConfig: string) {
		const tsConfig = _tsConfig.replace(/\\/g, '/');
		let project = configProjects.pathGet(tsConfig);
		if (!project) {
			const rootUri = URI.parse(fileNameToUri(path.dirname(tsConfig)));
			project = createTypeScriptProject({
				...context,
				project: {
					workspaceUri: getWorkspaceUri(rootUri),
					rootUri: rootUri,
					tsConfig,
				},
			});
			configProjects.pathSet(tsConfig, project);
		}
		return project;
	}
}

export function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

export function sortTSConfigs(file: string, a: string, b: string) {

	const inA = isFileInDir(file, path.dirname(a));
	const inB = isFileInDir(file, path.dirname(b));

	if (inA !== inB) {
		const aWeight = inA ? 1 : 0;
		const bWeight = inB ? 1 : 0;
		return bWeight - aWeight;
	}

	const aLength = a.split('/').length;
	const bLength = b.split('/').length;

	if (aLength === bLength) {
		const aWeight = path.basename(a) === 'tsconfig.json' ? 1 : 0;
		const bWeight = path.basename(b) === 'tsconfig.json' ? 1 : 0;
		return bWeight - aWeight;
	}

	return bLength - aLength;
}
