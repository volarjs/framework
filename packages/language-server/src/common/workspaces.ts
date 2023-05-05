import { ServiceEnvironment } from '@volar/language-service';
import type * as ts from 'typescript/lib/tsserverlibrary';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { DiagnosticModel, FileSystemHost, InitializationOptions, LanguageServerPlugin, ServerMode } from '../types';
import { CancellationTokenHost } from './cancellationPipe';
import { createDocuments } from './documents';
import { ServerContext } from './server';
import { createWorkspace, rootTsConfigNames, sortTsConfigs } from './workspace';
import { isFileInDir } from './utils/isFileInDir';
import * as path from 'typesafe-path';

import type * as _ from 'vscode-languageserver-textdocument';

export interface WorkspacesContext extends ServerContext {
	workspaces: {
		initParams: vscode.InitializeParams;
		initOptions: InitializationOptions;
		plugins: ReturnType<LanguageServerPlugin>[];
		ts: typeof import('typescript/lib/tsserverlibrary') | undefined;
		tsLocalized: ts.MapLike<string> | undefined;
		fileSystemHost: FileSystemHost | undefined;
		configurationHost: Pick<ServiceEnvironment, 'getConfiguration' | 'onDidChangeConfiguration'> | undefined;
		documents: ReturnType<typeof createDocuments>;
		cancelTokenHost: CancellationTokenHost;
	};
}

export interface Workspaces extends ReturnType<typeof createWorkspaces> { }

export function createWorkspaces(context: WorkspacesContext) {

	const uriToFileName = context.server.runtimeEnv.uriToFileName;

	const workspaces = new Map<string, ReturnType<typeof createWorkspace>>();

	let semanticTokensReq = 0;
	let documentUpdatedReq = 0;

	context.workspaces.documents.onDidChangeContent(({ textDocument }) => {
		updateDiagnostics(textDocument.uri);
	});
	context.workspaces.documents.onDidClose(({ textDocument }) => {
		context.server.connection.sendDiagnostics({ uri: textDocument.uri, diagnostics: [] });
	});
	context.workspaces.fileSystemHost?.onDidChangeWatchedFiles(({ changes }) => {
		const tsConfigChanges = changes.filter(change => rootTsConfigNames.includes(change.uri.substring(change.uri.lastIndexOf('/') + 1)));
		if (tsConfigChanges.length) {
			reloadDiagnostics();
		}
		else {
			updateDiagnosticsAndSemanticTokens();
		}
	});
	context.server.runtimeEnv.onDidChangeConfiguration?.(async () => {
		updateDiagnosticsAndSemanticTokens();
	});

	return {
		workspaces,
		getProject: getProjectAndTsConfig,
		reloadProject,
		add: (rootUri: URI) => {
			if (!workspaces.has(rootUri.toString())) {
				workspaces.set(rootUri.toString(), createWorkspace({
					...context,
					workspace: {
						rootUri,
					},
				}));
			}
		},
		remove: (rootUri: URI) => {
			const _workspace = workspaces.get(rootUri.toString());
			workspaces.delete(rootUri.toString());
			(async () => {
				(await _workspace)?.dispose();
			})();
		},
	};

	async function reloadProject() {

		context.workspaces.fileSystemHost?.reload();

		for (const [_, workspace] of workspaces) {
			(await workspace).reload();
		}

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
			if (context.workspaces.initParams.capabilities.textDocument?.semanticTokens) {
				context.server.connection.languages.semanticTokens.refresh();
			}
			if (context.workspaces.initParams.capabilities.textDocument?.inlayHint) {
				context.server.connection.languages.inlayHint.refresh();
			}
		}
	}

	async function updateDiagnostics(docUri?: string) {

		if ((context.workspaces.initOptions.diagnosticModel ?? DiagnosticModel.Push) !== DiagnosticModel.Push)
			return;

		const req = ++documentUpdatedReq;
		const delay = 250;
		const cancel = context.workspaces.cancelTokenHost.createCancellationToken({
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

		const project = (await getProjectAndTsConfig(uri))?.project;
		if (!project) return;

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

	async function getProjectAndTsConfig(uri: string) {

		let rootUris = [...workspaces.keys()]
			.filter(rootUri => isFileInDir(uriToFileName(uri) as path.PosixPath, uriToFileName(rootUri) as path.PosixPath))
			.sort((a, b) => sortTsConfigs(uriToFileName(uri) as path.PosixPath, uriToFileName(a) as path.PosixPath, uriToFileName(b) as path.PosixPath));

		if (context.workspaces.initOptions.serverMode !== ServerMode.Syntactic) {
			for (const rootUri of rootUris) {
				const workspace = await workspaces.get(rootUri);
				const projectAndTsConfig = await workspace?.getProjectAndTsConfig(uri);
				if (projectAndTsConfig) {
					return projectAndTsConfig;
				}
			}
		}

		if (!rootUris.length) {
			rootUris = [...workspaces.keys()];
		}

		if (rootUris.length) {
			const project = await (await workspaces.get(rootUris[0]))?.getInferredProject();
			project?.tryAddFile(uriToFileName(uri));
			return {
				tsconfig: undefined,
				project,
			};
		}
	}
}

export function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
