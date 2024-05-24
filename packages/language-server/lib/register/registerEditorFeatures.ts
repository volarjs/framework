import type { CodeMapping, VirtualCode } from '@volar/language-core';
import { createUriMap, type DataTransferItem } from '@volar/language-service';
import type * as ts from 'typescript';
import {
	DocumentDropRequest,
	DocumentDrop_DataTransferItemAsStringRequest,
	DocumentDrop_DataTransferItemFileDataRequest,
	GetMatchTsConfigRequest,
	GetServicePluginsRequest,
	GetVirtualCodeRequest,
	GetVirtualFileRequest,
	LoadedTSFilesMetaRequest,
	UpdateServicePluginStateNotification,
	UpdateVirtualCodeStateNotification,
	WriteVirtualFilesNotification,
} from '../../protocol';
import type { LanguageServer } from '../types';
import { URI } from 'vscode-uri';

export function registerEditorFeatures(server: LanguageServer) {

	const scriptVersions = createUriMap<number>();
	const scriptVersionSnapshots = new WeakSet<ts.IScriptSnapshot>();

	server.connection.onRequest(DocumentDropRequest.type, async ({ textDocument, position, dataTransfer }, token) => {

		const dataTransferMap = new Map<string, DataTransferItem>();

		for (const item of dataTransfer) {
			dataTransferMap.set(item.mimeType, {
				value: item.value,
				asString() {
					return server.connection.sendRequest(DocumentDrop_DataTransferItemAsStringRequest.type, { mimeType: item.mimeType });
				},
				asFile() {
					if (item.file) {
						return {
							name: item.file.name,
							uri: item.file.uri,
							data() {
								return server.connection.sendRequest(DocumentDrop_DataTransferItemFileDataRequest.type, { mimeType: item.mimeType });
							},
						};
					}
				},
			});
		}

		const uri = URI.parse(textDocument.uri);
		const languageService = (await server.project.getLanguageService(server, uri));
		return languageService.doDocumentDrop(uri, position, dataTransferMap, token);
	});
	server.connection.onRequest(GetMatchTsConfigRequest.type, async params => {
		const uri = URI.parse(params.uri);
		const languageService = (await server.project.getLanguageService(server, uri));
		if (languageService.context.language.typescript?.configFileName) {
			const { configFileName, asScriptId } = languageService.context.language.typescript;
			return { uri: asScriptId(configFileName).toString() };
		}
	});
	server.connection.onRequest(GetVirtualFileRequest.type, async document => {
		const uri = URI.parse(document.uri);
		const languageService = (await server.project.getLanguageService(server, uri));
		const documentUri = URI.parse(document.uri);
		const sourceScript = languageService.context.language.scripts.get(documentUri);
		if (sourceScript?.generated) {
			return prune(sourceScript.generated.root);
		}

		function prune(virtualCode: VirtualCode): GetVirtualFileRequest.VirtualCodeInfo {
			const uri = languageService.context.encodeEmbeddedDocumentUri(sourceScript!.id, virtualCode.id);
			let version = scriptVersions.get(uri) ?? 0;
			if (!scriptVersionSnapshots.has(virtualCode.snapshot)) {
				version++;
				scriptVersions.set(uri, version);
				scriptVersionSnapshots.add(virtualCode.snapshot);
			}
			return {
				fileUri: sourceScript!.id.toString(),
				virtualCodeId: virtualCode.id,
				languageId: virtualCode.languageId,
				embeddedCodes: virtualCode.embeddedCodes?.map(prune) || [],
				version,
				disabled: languageService.context.disabledEmbeddedDocumentUris.has(uri),
			};
		}
	});
	server.connection.onRequest(GetVirtualCodeRequest.type, async params => {
		const uri = URI.parse(params.fileUri);
		const languageService = (await server.project.getLanguageService(server, uri));
		const sourceScript = languageService.context.language.scripts.get(URI.parse(params.fileUri));
		const virtualCode = sourceScript?.generated?.embeddedCodes.get(params.virtualCodeId);
		if (virtualCode) {
			const mappings: Record<string, CodeMapping[]> = {};
			for (const map of languageService.context.documents.getMaps(virtualCode)) {
				mappings[map.sourceDocument.uri] = map.map.mappings;
			}
			return {
				content: virtualCode.snapshot.getText(0, virtualCode.snapshot.getLength()),
				mappings,
			};
		}
	});
	server.connection.onNotification(WriteVirtualFilesNotification.type, async params => {

		const fsModeName = 'fs'; // avoid bundle
		const fs: typeof import('fs') = await import(fsModeName);
		const uri = URI.parse(params.uri);
		const languageService = (await server.project.getLanguageService(server, uri));

		if (languageService.context.language.typescript) {

			const { languageServiceHost } = languageService.context.language.typescript;

			for (const fileName of languageServiceHost.getScriptFileNames()) {
				if (!fs.existsSync(fileName)) {
					// global virtual files
					const snapshot = languageServiceHost.getScriptSnapshot(fileName);
					if (snapshot) {
						fs.writeFile(fileName, snapshot.getText(0, snapshot.getLength()), () => { });
					}
				}
				else {
					const sourceScript = languageService.context.language.scripts.get(uri);
					if (sourceScript?.generated) {
						const serviceScript = sourceScript.generated.languagePlugin.typescript?.getServiceScript(sourceScript.generated.root);
						if (serviceScript) {
							const { snapshot } = serviceScript.code;
							fs.writeFile(fileName + serviceScript.extension, snapshot.getText(0, snapshot.getLength()), () => { });
						}
						if (sourceScript.generated.languagePlugin.typescript?.getExtraServiceScripts) {
							for (const extraServiceScript of sourceScript.generated.languagePlugin.typescript.getExtraServiceScripts(uri.toString(), sourceScript.generated.root)) {
								const { snapshot } = extraServiceScript.code;
								fs.writeFile(fileName, snapshot.getText(0, snapshot.getLength()), () => { });
							}
						}
					}
				}
			}
		}
	});
	server.connection.onRequest(LoadedTSFilesMetaRequest.type, async () => {

		const sourceFilesData = new Map<ts.SourceFile, {
			projectNames: string[];
			size: number;
		}>();

		for (const languageService of await server.project.allLanguageServices(server)) {
			const tsLanguageService: ts.LanguageService | undefined = languageService.context.inject<any>('typescript/languageService');
			const program = tsLanguageService?.getProgram();
			if (program && languageService.context.language.typescript) {
				const { languageServiceHost, configFileName } = languageService.context.language.typescript;
				const projectName = configFileName ?? (languageServiceHost.getCurrentDirectory() + '(inferred)');
				const sourceFiles = program.getSourceFiles() ?? [];
				for (const sourceFile of sourceFiles) {
					if (!sourceFilesData.has(sourceFile)) {
						let nodes = 0;
						sourceFile.forEachChild(function walk(node) {
							nodes++;
							node.forEachChild(walk);
						});
						sourceFilesData.set(sourceFile, {
							projectNames: [],
							size: nodes * 128,
						});
					}
					sourceFilesData.get(sourceFile)!.projectNames.push(projectName);
				};
			}
		}

		const result: {
			inputs: {};
			outputs: Record<string, {
				imports: string[];
				exports: string[];
				entryPoint: string;
				inputs: Record<string, { bytesInOutput: number; }>;
				bytes: number;
			}>;
		} = {
			inputs: {},
			outputs: {},
		};

		for (const [sourceFile, fileData] of sourceFilesData) {
			let key = fileData.projectNames.sort().join(', ');
			if (fileData.projectNames.length >= 2) {
				key = `Shared in ${fileData.projectNames.length} projects (${key})`;
			}
			result.outputs[key] ??= {
				imports: [],
				exports: [],
				entryPoint: '',
				inputs: {},
				bytes: 0,
			};
			result.outputs[key].inputs[sourceFile.fileName] = { bytesInOutput: fileData.size };
		}

		return result;
	});
	server.connection.onNotification(UpdateVirtualCodeStateNotification.type, async params => {
		const uri = URI.parse(params.fileUri);
		const languageService = await server.project.getLanguageService(server, uri);
		const virtualFileUri = languageService.context.encodeEmbeddedDocumentUri(URI.parse(params.fileUri), params.virtualCodeId);
		if (params.disabled) {
			languageService.context.disabledEmbeddedDocumentUris.set(virtualFileUri, true);
		}
		else {
			languageService.context.disabledEmbeddedDocumentUris.delete(virtualFileUri);
		}
	});
	server.connection.onNotification(UpdateServicePluginStateNotification.type, async params => {
		const uri = URI.parse(params.uri);
		const languageService = await server.project.getLanguageService(server, uri);
		const service = languageService.context.services[params.serviceId as any][1];
		if (params.disabled) {
			languageService.context.disabledServicePlugins.add(service);
		}
		else {
			languageService.context.disabledServicePlugins.delete(service);
		}
	});
	server.connection.onRequest(GetServicePluginsRequest.type, async params => {
		const uri = URI.parse(params.uri);
		const languageService = await server.project.getLanguageService(server, uri);
		const result: GetServicePluginsRequest.ResponseType = [];
		for (let id in languageService.context.services) {
			const service = languageService.context.services[id];
			result.push({
				id,
				name: service[0].name,
				disabled: languageService.context.disabledServicePlugins.has(service[1]),
				features: Object.keys(service[1]),
			});
		}
		return result;
	});
}
