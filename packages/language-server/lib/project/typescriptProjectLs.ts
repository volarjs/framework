import { LanguagePlugin, LanguageService, LanguageServiceEnvironment, ProviderResult, UriMap, createLanguage, createLanguageService, createUriMap } from '@volar/language-service';
import type { SnapshotDocument } from '@volar/snapshot-document';
import { TypeScriptProjectHost, createLanguageServiceHost, createSys, resolveFileLanguageId } from '@volar/typescript';
import * as path from 'path-browserify';
import type * as ts from 'typescript';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import type { LanguageServer } from '../types';

export interface TypeScriptProjectLS {
	askedFiles: UriMap<boolean>;
	tryAddFile(fileName: string): void;
	getParsedCommandLine(): ts.ParsedCommandLine;
	languageService: LanguageService;
	dispose(): void;
}

export interface ProjectExposeContext {
	configFileName: string | undefined;
	projectHost: TypeScriptProjectHost;
	sys: ReturnType<typeof createSys>;
	asUri(fileName: string): URI;
	asFileName(scriptId: URI): string;
}

const fsFileSnapshots = createUriMap<[number | undefined, ts.IScriptSnapshot | undefined]>();

export async function createTypeScriptLS(
	ts: typeof import('typescript'),
	tsLocalized: ts.MapLike<string> | undefined,
	tsconfig: string | ts.CompilerOptions,
	server: LanguageServer,
	serviceEnv: LanguageServiceEnvironment,
	workspaceFolder: URI,
	getLanguagePlugins: (
		env: LanguageServiceEnvironment,
		projectContext: ProjectExposeContext
	) => ProviderResult<LanguagePlugin<URI>[]>,
	{
		asUri,
		asFileName,
	}: {
		asUri(fileName: string): URI;
		asFileName(uri: URI): string;
	}
): Promise<TypeScriptProjectLS> {

	let parsedCommandLine: ts.ParsedCommandLine;
	let projectVersion = 0;

	const sys = createSys(ts.sys, serviceEnv, workspaceFolder, {
		asFileName,
		asUri,
	});
	const projectHost: TypeScriptProjectHost = {
		getCurrentDirectory() {
			return asFileName(workspaceFolder);
		},
		getProjectVersion() {
			return projectVersion.toString();
		},
		getScriptFileNames() {
			return rootFiles;
		},
		getScriptSnapshot(fileName) {
			const uri = asUri(fileName);
			const documentKey = server.getSyncedDocumentKey(uri) ?? uri.toString();
			const document = server.documents.get(documentKey);
			askedFiles.set(uri, true);
			if (document) {
				return document.getSnapshot();
			}
		},
		getCompilationSettings() {
			return parsedCommandLine.options;
		},
		getLocalizedDiagnosticMessages: tsLocalized ? () => tsLocalized : undefined,
		getProjectReferences() {
			return parsedCommandLine.projectReferences;
		},
	};
	const languagePlugins = await getLanguagePlugins(serviceEnv, {
		configFileName: typeof tsconfig === 'string' ? tsconfig : undefined,
		projectHost,
		sys,
		asFileName,
		asUri,
	});
	const askedFiles = createUriMap<boolean>();
	const docOpenWatcher = server.documents.onDidOpen(({ document }) => updateFsCacheFromSyncedDocument(document));
	const docSaveWatcher = server.documents.onDidSave(({ document }) => updateFsCacheFromSyncedDocument(document));
	const docChangeWatcher = server.documents.onDidChangeContent(() => projectVersion++);
	const fileWatch = serviceEnv.onDidChangeWatchedFiles?.(params => onWorkspaceFilesChanged(params.changes));

	let rootFiles = await getRootFiles(languagePlugins);

	const language = createLanguage<URI>(
		[
			{ getLanguageId: uri => server.documents.get(server.getSyncedDocumentKey(uri) ?? uri.toString())?.languageId },
			...languagePlugins,
			{ getLanguageId: uri => resolveFileLanguageId(uri.path) },
		],
		createUriMap(sys.useCaseSensitiveFileNames),
		uri => {
			askedFiles.set(uri, true);

			const documentUri = server.getSyncedDocumentKey(uri);
			const syncedDocument = documentUri ? server.documents.get(documentUri) : undefined;

			let snapshot: ts.IScriptSnapshot | undefined;

			if (syncedDocument) {
				snapshot = syncedDocument.getSnapshot();
			}
			else {
				// fs files
				const cache = fsFileSnapshots.get(uri);
				const fileName = asFileName(uri);
				const modifiedTime = sys.getModifiedTime?.(fileName)?.valueOf();
				if (!cache || cache[0] !== modifiedTime) {
					if (sys.fileExists(fileName)) {
						const text = sys.readFile(fileName);
						const snapshot = text !== undefined ? ts.ScriptSnapshot.fromString(text) : undefined;
						fsFileSnapshots.set(uri, [modifiedTime, snapshot]);
					}
					else {
						fsFileSnapshots.set(uri, [modifiedTime, undefined]);
					}
				}
				snapshot = fsFileSnapshots.get(uri)?.[1];
			}

			if (snapshot) {
				language.scripts.set(uri, snapshot);
			}
			else {
				language.scripts.delete(uri);
			}
		}
	);
	language.typescript = {
		configFileName: typeof tsconfig === 'string' ? tsconfig : undefined,
		sys,
		asScriptId: asUri,
		asFileName: asFileName,
		...createLanguageServiceHost(
			ts,
			sys,
			language,
			asUri,
			projectHost
		),
	};
	const languageService = createLanguageService(
		language,
		server.languageServicePlugins,
		serviceEnv
	);

	return {
		askedFiles,
		languageService,
		tryAddFile(fileName: string) {
			if (!rootFiles.includes(fileName)) {
				rootFiles.push(fileName);
				projectVersion++;
			}
		},
		dispose: () => {
			sys.dispose();
			languageService?.dispose();
			fileWatch?.dispose();
			docOpenWatcher.dispose();
			docSaveWatcher.dispose();
			docChangeWatcher.dispose();
		},
		getParsedCommandLine: () => parsedCommandLine,
	};

	function updateFsCacheFromSyncedDocument(document: SnapshotDocument) {
		const uri = URI.parse(document.uri);
		const fileName = asFileName(uri);
		if (fsFileSnapshots.has(uri) || sys.fileExists(fileName)) {
			const modifiedTime = sys.getModifiedTime?.(fileName);
			fsFileSnapshots.set(uri, [modifiedTime?.valueOf(), document.getSnapshot()]);
		}
	}

	async function getRootFiles(languagePlugins: LanguagePlugin<URI>[]) {
		parsedCommandLine = await createParsedCommandLine(
			ts,
			sys,
			asFileName(workspaceFolder),
			tsconfig,
			languagePlugins.map(plugin => plugin.typescript?.extraFileExtensions ?? []).flat()
		);
		return parsedCommandLine.fileNames;
	}
	async function onWorkspaceFilesChanged(changes: vscode.FileEvent[]) {

		const createsAndDeletes = changes.filter(change => change.type !== vscode.FileChangeType.Changed);

		if (createsAndDeletes.length) {
			rootFiles = await getRootFiles(languagePlugins);
		}

		projectVersion++;
	}
}

async function createParsedCommandLine(
	ts: typeof import('typescript'),
	sys: ReturnType<typeof createSys>,
	workspacePath: string,
	tsconfig: string | ts.CompilerOptions,
	extraFileExtensions: ts.FileExtensionInfo[]
): Promise<ts.ParsedCommandLine> {
	let content: ts.ParsedCommandLine = {
		errors: [],
		fileNames: [],
		options: {},
	};
	let sysVersion: number | undefined;
	let newSysVersion = await sys.sync();
	while (sysVersion !== newSysVersion) {
		sysVersion = newSysVersion;
		try {
			if (typeof tsconfig === 'string') {
				const config = ts.readJsonConfigFile(tsconfig, sys.readFile);
				content = ts.parseJsonSourceFileConfigFileContent(config, sys, path.dirname(tsconfig), {}, tsconfig, undefined, extraFileExtensions);
			}
			else {
				content = ts.parseJsonConfigFileContent({ files: [] }, sys, workspacePath, tsconfig, workspacePath + '/jsconfig.json', undefined, extraFileExtensions);
			}
			// fix https://github.com/johnsoncodehk/volar/issues/1786
			// https://github.com/microsoft/TypeScript/issues/30457
			// patching ts server broke with outDir + rootDir + composite/incremental
			content.options.outDir = undefined;
			content.fileNames = content.fileNames.map(fileName => fileName.replace(/\\/g, '/'));
		}
		catch {
			// will be failed if web fs host first result not ready
		}
		newSysVersion = await sys.sync();
	}
	if (content) {
		return content;
	}
	return content;
}
