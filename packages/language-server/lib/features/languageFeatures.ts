import { DataTransferItem, decodeEmbeddedDocumentUri, LanguageService, mergeWorkspaceEdits } from '@volar/language-service';
import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { AutoInsertRequest, DocumentDrop_DataTransferItemAsStringRequest, DocumentDrop_DataTransferItemFileDataRequest, DocumentDropRequest, FindFileReferenceRequest } from '../../protocol';
import type { LanguageServerProject, LanguageServerState } from '../types.js';
import { SnapshotDocument } from '../utils/snapshotDocument';

export function register(
	server: LanguageServerState,
	documents: ReturnType<typeof import('./textDocuments')['register']>,
	configurations: ReturnType<typeof import('./configurations')['register']>
) {
	// Diagnostics support
	let refreshReq = 0;
	let updateDiagnosticsBatchReq = 0;

	const refreshHandlers: ((clearDiagnostics: boolean) => void)[] = [];

	server.onInitialize(serverCapabilities => {
		let lastCompleteUri: string;
		let lastCompleteLs: LanguageService | undefined;
		let lastCodeLensLs: LanguageService | undefined;
		let lastCodeActionLs: LanguageService | undefined;
		let lastCallHierarchyLs: LanguageService | undefined;
		let lastDocumentLinkLs: LanguageService | undefined;
		let lastInlayHintLs: LanguageService | undefined;
		let languageServiceToId = new WeakMap<LanguageService, number>();
		let currentLanguageServiceId = 0;

		const languageServiceById = new Map<number, WeakRef<LanguageService>>();
		const { languageServicePlugins, project, initializeParams } = server;

		if (languageServicePlugins.some(({ capabilities }) => capabilities.selectionRangeProvider)) {
			serverCapabilities.selectionRangeProvider = true;
			server.connection.onSelectionRanges(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getSelectionRanges(uri, params.positions, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.foldingRangeProvider)) {
			serverCapabilities.foldingRangeProvider = true;
			server.connection.onFoldingRanges(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getFoldingRanges(uri, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.linkedEditingRangeProvider)) {
			serverCapabilities.linkedEditingRangeProvider = true;
			server.connection.languages.onLinkedEditingRange(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getLinkedEditingRanges(uri, params.position, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.colorProvider)) {
			serverCapabilities.colorProvider = true;
			server.connection.onDocumentColor(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDocumentColors(uri, token);
				});
			});
			server.connection.onColorPresentation(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getColorPresentations(uri, params.color, params.range, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.documentSymbolProvider)) {
			serverCapabilities.documentSymbolProvider = true;
			server.connection.onDocumentSymbol(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDocumentSymbols(uri, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.documentFormattingProvider)) {
			serverCapabilities.documentFormattingProvider = true;
			serverCapabilities.documentRangeFormattingProvider = true;
			server.connection.onDocumentFormatting(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDocumentFormattingEdits(uri, params.options, undefined, undefined, token);
				});
			});
			server.connection.onDocumentRangeFormatting(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDocumentFormattingEdits(uri, params.options, params.range, undefined, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.referencesProvider)) {
			serverCapabilities.referencesProvider = true;
			server.connection.onReferences(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getReferences(uri, params.position, { includeDeclaration: true }, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.implementationProvider)) {
			serverCapabilities.implementationProvider = true;
			server.connection.onImplementation(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getImplementations(uri, params.position, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.definitionProvider)) {
			serverCapabilities.definitionProvider = true;
			server.connection.onDefinition(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDefinition(uri, params.position, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.typeDefinitionProvider)) {
			serverCapabilities.typeDefinitionProvider = true;
			server.connection.onTypeDefinition(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getTypeDefinition(uri, params.position, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.callHierarchyProvider)) {
			serverCapabilities.callHierarchyProvider = true;
			server.connection.languages.callHierarchy.onPrepare(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					lastCallHierarchyLs = languageService;
					return languageService.getCallHierarchyItems(uri, params.position, token);
				}) ?? [];
			});
			server.connection.languages.callHierarchy.onIncomingCalls(async (params, token) => {
				return await lastCallHierarchyLs?.getCallHierarchyIncomingCalls(params.item, token) ?? [];
			});
			server.connection.languages.callHierarchy.onOutgoingCalls(async (params, token) => {
				return await lastCallHierarchyLs?.getCallHierarchyOutgoingCalls(params.item, token) ?? [];
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.hoverProvider)) {
			serverCapabilities.hoverProvider = true;
			server.connection.onHover(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getHover(uri, params.position, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.documentHighlightProvider)) {
			serverCapabilities.documentHighlightProvider = true;
			server.connection.onDocumentHighlight(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDocumentHighlights(uri, params.position, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.workspaceSymbolProvider)) {
			serverCapabilities.workspaceSymbolProvider = {};
			server.connection.onWorkspaceSymbol(async (params, token) => {
				const symbols: vscode.WorkspaceSymbol[] = [];
				for (const languageService of await project.getExistingLanguageServices()) {
					if (token.isCancellationRequested) {
						return;
					}
					let languageServiceId = languageServiceToId.get(languageService);
					if (languageServiceId === undefined) {
						languageServiceId = currentLanguageServiceId;
						languageServiceToId.set(languageService, languageServiceId);
						languageServiceById.set(languageServiceId, new WeakRef(languageService));
					}
					const languageServiceResult = await languageService.getWorkspaceSymbols(params.query, token);
					for (const symbol of languageServiceResult) {
						symbol.data = {
							languageServiceId,
							originalData: symbol.data,
						};
					}
					symbols.push(...await languageService.getWorkspaceSymbols(params.query, token));
				}
				return symbols;
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.workspaceSymbolProvider?.resolveProvider)) {
				serverCapabilities.workspaceSymbolProvider.resolveProvider = true;
				server.connection.onWorkspaceSymbolResolve(async (symbol, token) => {
					const languageServiceId = (symbol.data as any)?.languageServiceId;
					const languageService = languageServiceById.get(languageServiceId)?.deref();
					if (!languageService) {
						return symbol;
					}
					symbol.data = (symbol.data as any)?.originalData;
					return await languageService.resolveWorkspaceSymbol?.(symbol, token);
				});
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.renameProvider)) {
			serverCapabilities.renameProvider = {};
			server.connection.onRenameRequest(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getRenameEdits(uri, params.position, params.newName, token);
				});
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.renameProvider?.prepareProvider)) {
				serverCapabilities.renameProvider.prepareProvider = true;
				server.connection.onPrepareRename(async (params, token) => {
					const uri = URI.parse(params.textDocument.uri);
					return await worker(uri, token, async languageService => {
						const result = await languageService.getRenameRange(uri, params.position, token);
						if (result && 'message' in result) {
							return new vscode.ResponseError(0, result.message);
						}
						return result;
					});
				});
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.documentLinkProvider)) {
			serverCapabilities.documentLinkProvider = {};
			server.connection.onDocumentLinks(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					lastDocumentLinkLs = languageService;
					return languageService.getDocumentLinks(uri, token);
				});
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.documentLinkProvider?.resolveProvider)) {
				serverCapabilities.documentLinkProvider.resolveProvider = true;
				server.connection.onDocumentLinkResolve(async (link, token) => {
					return await lastDocumentLinkLs?.resolveDocumentLink(link, token);
				});
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.codeLensProvider)) {
			serverCapabilities.codeLensProvider = {};
			server.connection.onCodeLens(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					lastCodeLensLs = languageService;
					return languageService.getCodeLenses(uri, token);
				});
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.codeLensProvider?.resolveProvider)) {
				serverCapabilities.codeLensProvider.resolveProvider = true;
				server.connection.onCodeLensResolve(async (codeLens, token) => {
					return await lastCodeLensLs?.resolveCodeLens(codeLens, token) ?? codeLens;
				});
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.inlayHintProvider)) {
			serverCapabilities.inlayHintProvider = {};
			server.connection.languages.inlayHint.on(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					lastInlayHintLs = languageService;
					return languageService.getInlayHints(uri, params.range, token);
				});
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.inlayHintProvider?.resolveProvider)) {
				serverCapabilities.inlayHintProvider.resolveProvider = true;
				server.connection.languages.inlayHint.resolve(async (hint, token) => {
					return await lastInlayHintLs?.resolveInlayHint(hint, token) ?? hint;
				});
			}

			if (initializeParams.capabilities.workspace?.inlayHint?.refreshSupport) {
				refreshHandlers.push(() => {
					server.connection.languages.inlayHint.refresh();
				});
			}
			else {
				console.warn('Inlay hint refresh is not supported by the client.');
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.signatureHelpProvider)) {
			serverCapabilities.signatureHelpProvider = {
				triggerCharacters: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.signatureHelpProvider?.triggerCharacters ?? []).flat())],
				retriggerCharacters: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.signatureHelpProvider?.retriggerCharacters ?? []).flat())],
			};
			server.connection.onSignatureHelp(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getSignatureHelp(uri, params.position, params.context, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.completionProvider)) {
			serverCapabilities.completionProvider = {
				triggerCharacters: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.completionProvider?.triggerCharacters ?? []).flat())],
			};
			server.connection.onCompletion(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, async languageService => {
					lastCompleteUri = params.textDocument.uri;
					lastCompleteLs = languageService;
					const list = await languageService.getCompletionItems(
						uri,
						params.position,
						params.context,
						token
					);
					for (const item of list.items) {
						fixTextEdit(initializeParams, item);
					}
					return list;
				});
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.completionProvider?.resolveProvider)) {
				serverCapabilities.completionProvider.resolveProvider = true;
				server.connection.onCompletionResolve(async (item, token) => {
					if (lastCompleteUri && lastCompleteLs) {
						item = await lastCompleteLs.resolveCompletionItem(item, token);
						fixTextEdit(initializeParams, item);
					}
					return item;
				});
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.semanticTokensProvider)) {
			serverCapabilities.semanticTokensProvider = {
				range: true,
				full: false, // TODO: enable it after testing
				legend: {
					tokenTypes: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.semanticTokensProvider?.legend?.tokenTypes ?? []).flat())],
					tokenModifiers: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.semanticTokensProvider?.legend?.tokenModifiers ?? []).flat())],
				},
			};
			server.connection.languages.semanticTokens.on(async (params, token, _, resultProgress) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, async languageService => {
					return await languageService?.getSemanticTokens(
						uri,
						undefined,
						serverCapabilities.semanticTokensProvider!.legend,
						tokens => resultProgress?.report(tokens),
						token
					);
				}) ?? { data: [] };
			});
			server.connection.languages.semanticTokens.onRange(async (params, token, _, resultProgress) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, async languageService => {
					return await languageService?.getSemanticTokens(
						uri,
						params.range,
						serverCapabilities.semanticTokensProvider!.legend,
						tokens => resultProgress?.report(tokens),
						token
					);
				}) ?? { data: [] };
			});

			if (initializeParams.capabilities.workspace?.semanticTokens?.refreshSupport) {
				refreshHandlers.push(() => {
					server.connection.languages.semanticTokens.refresh();
				});
			}
			else {
				console.warn('Semantic tokens refresh is not supported by the client.');
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.codeActionProvider)) {
			serverCapabilities.codeActionProvider = {
				codeActionKinds: languageServicePlugins.some(({ capabilities }) => capabilities.codeActionProvider?.codeActionKinds)
					? [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.codeActionProvider?.codeActionKinds ?? []).flat())]
					: undefined,
			};
			server.connection.onCodeAction(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, async languageService => {
					lastCodeActionLs = languageService;
					let codeActions = await languageService.getCodeActions(uri, params.range, params.context, token) ?? [];
					for (const codeAction of codeActions) {
						if (codeAction.data && typeof codeAction.data === 'object') {
							(codeAction.data as any).uri = params.textDocument.uri;
						}
						else {
							codeAction.data = { uri: params.textDocument.uri };
						}
					}
					if (!initializeParams.capabilities.textDocument?.codeAction?.disabledSupport) {
						codeActions = codeActions.filter(codeAction => !codeAction.disabled);
					}
					return codeActions;
				});
			});
			if (languageServicePlugins.some(({ capabilities }) => capabilities.codeActionProvider?.resolveProvider)) {
				serverCapabilities.codeActionProvider.resolveProvider = true;
				server.connection.onCodeActionResolve(async (codeAction, token) => {
					return await lastCodeActionLs?.resolveCodeAction(codeAction, token) ?? codeAction;
				});
			}
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.documentOnTypeFormattingProvider)) {
			serverCapabilities.documentOnTypeFormattingProvider = {
				firstTriggerCharacter: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.documentOnTypeFormattingProvider?.triggerCharacters ?? []).flat())][0],
				moreTriggerCharacter: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.documentOnTypeFormattingProvider?.triggerCharacters ?? []).flat())].slice(1),
			};
			server.connection.onDocumentOnTypeFormatting(async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getDocumentFormattingEdits(uri, params.options, undefined, params, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.executeCommandProvider)) {
			serverCapabilities.executeCommandProvider = {
				commands: [...new Set(languageServicePlugins.map(({ capabilities }) => capabilities.executeCommandProvider?.commands ?? []).flat())],
			};
			server.connection.onExecuteCommand(async (params, token) => {
				for (const languageService of await project.getExistingLanguageServices()) {
					if (languageService.executeCommand && languageService.commands.includes(params.command)) {
						try {
							return await languageService.executeCommand(params.command, params.arguments ?? [], token);
						} catch { }
					}
				}
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.autoInsertionProvider)) {
			const triggerCharacterToConfigurationSections = new Map<string, Set<string>>();
			const tryAdd = (char: string, section?: string) => {
				let sectionSet = triggerCharacterToConfigurationSections.get(char);
				if (!sectionSet) {
					triggerCharacterToConfigurationSections.set(char, sectionSet = new Set());
				}
				if (section) {
					sectionSet.add(section);
				}
			};
			for (const { capabilities } of languageServicePlugins) {
				if (capabilities.autoInsertionProvider) {
					const { triggerCharacters, configurationSections } = capabilities.autoInsertionProvider;
					if (configurationSections) {
						if (configurationSections.length !== triggerCharacters.length) {
							throw new Error('configurationSections.length !== triggerCharacters.length');
						}
						for (let i = 0; i < configurationSections.length; i++) {
							tryAdd(triggerCharacters[i], configurationSections[i]);
						}
					}
					else {
						for (const char of triggerCharacters) {
							tryAdd(char);
						}
					}
				}
			}
			serverCapabilities.experimental ??= {};
			serverCapabilities.experimental.autoInsertionProvider = {
				triggerCharacters: [],
				configurationSections: [],
			};
			for (const [char, sections] of triggerCharacterToConfigurationSections) {
				if (sections.size) {
					serverCapabilities.experimental.autoInsertionProvider.triggerCharacters.push(char);
					serverCapabilities.experimental.autoInsertionProvider.configurationSections!.push([...sections]);
				}
				else {
					serverCapabilities.experimental.autoInsertionProvider.triggerCharacters.push(char);
					serverCapabilities.experimental.autoInsertionProvider.configurationSections!.push(null);
				}
			}
			server.connection.onRequest(AutoInsertRequest.type, async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getAutoInsertSnippet(uri, params.selection, params.change, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.fileRenameEditsProvider)) {
			serverCapabilities.experimental ??= {};
			serverCapabilities.experimental.fileRenameEditsProvider = true;
			server.connection.workspace.onWillRenameFiles(async (params, token) => {
				const _edits = await Promise.all(params.files.map(async file => {
					const oldUri = URI.parse(file.oldUri);
					const newUri = URI.parse(file.newUri);
					return await worker(oldUri, token, languageService => {
						return languageService.getFileRenameEdits(oldUri, newUri, token) ?? null;
					}) ?? null;
				}));
				const edits = _edits.filter((edit): edit is NonNullable<typeof edit> => !!edit);
				if (edits.length) {
					mergeWorkspaceEdits(edits[0], ...edits.slice(1));
					return edits[0];
				}
				return null;
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.fileReferencesProvider)) {
			serverCapabilities.experimental ??= {};
			serverCapabilities.experimental.fileReferencesProvider = true;
			server.connection.onRequest(FindFileReferenceRequest.type, async (params, token) => {
				const uri = URI.parse(params.textDocument.uri);
				return await worker(uri, token, languageService => {
					return languageService.getFileReferences(uri, token);
				});
			});
		}

		if (languageServicePlugins.some(({ capabilities }) => capabilities.documentDropEditsProvider)) {
			serverCapabilities.experimental ??= {};
			serverCapabilities.experimental.documentDropEditsProvider = true;
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
				const languageService = (await project.getLanguageService(uri));
				return languageService.getDocumentDropEdits(uri, position, dataTransferMap, token);
			});
		}

		// Diagnostic support
		const supportsDiagnosticPull = !!initializeParams.capabilities.workspace?.diagnostics;
		const diagnosticProvider = languageServicePlugins.some(({ capabilities }) => !!capabilities.diagnosticProvider);
		const interFileDependencies = languageServicePlugins.some(({ capabilities }) => capabilities.diagnosticProvider?.interFileDependencies);
		const workspaceDiagnostics = languageServicePlugins.some(({ capabilities }) => capabilities.diagnosticProvider?.workspaceDiagnostics);

		if (diagnosticProvider) {
			if (supportsDiagnosticPull && !interFileDependencies) {
				serverCapabilities.diagnosticProvider = {
					// Unreliable, see https://github.com/microsoft/vscode-languageserver-node/issues/848#issuecomment-2189521060
					interFileDependencies: false,
					workspaceDiagnostics,
				};

				refreshHandlers.push(() => {
					if (initializeParams.capabilities.workspace?.diagnostics?.refreshSupport) {
						server.connection.languages.diagnostics.refresh();
					}
					else {
						console.warn('Diagnostics refresh is not supported by the client.');
					}
				});
			}
			else {
				documents.onDidChangeContent(({ document }) => {
					const changedDocument = documents.get(URI.parse(document.uri));
					if (!changedDocument) {
						return;
					}
					if (interFileDependencies) {
						const remainingDocuments = [...documents.all()].filter(doc => doc !== changedDocument);
						updateDiagnosticsBatch(project, [changedDocument, ...remainingDocuments]);
					}
					else {
						updateDiagnosticsBatch(project, [changedDocument]);
					}
				});
				documents.onDidClose(({ document }) => {
					server.connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
				});
				configurations.onDidChange(() => requestRefresh(false));

				refreshHandlers.push(async clearDiagnostics => {
					if (clearDiagnostics) {
						for (const document of documents.all()) {
							server.connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
						}
					}
					await updateDiagnosticsBatch(project, [...documents.all()]);
				});
			}
			server.connection.languages.diagnostics.on(async (params, token, _workDoneProgressReporter, resultProgressReporter) => {
				const uri = URI.parse(params.textDocument.uri);
				const result = await worker(uri, token, languageService => {
					return languageService.getDiagnostics(
						uri,
						errors => {
							// resultProgressReporter is undefined in vscode
							resultProgressReporter?.report({
								relatedDocuments: {
									[params.textDocument.uri]: {
										kind: vscode.DocumentDiagnosticReportKind.Full,
										items: errors,
									},
								},
							});
						},
						token
					);
				});
				return {
					kind: vscode.DocumentDiagnosticReportKind.Full,
					items: result ?? [],
				};
			});
		}

		if (workspaceDiagnostics) {
			server.connection.languages.diagnostics.onWorkspace(async (_params, token) => {
				const items: vscode.WorkspaceDocumentDiagnosticReport[] = [];
				for (const languageService of await project.getExistingLanguageServices()) {
					if (token.isCancellationRequested) {
						break;
					}
					const result = await languageService.getWorkspaceDiagnostics(token);
					items.push(...result);
				}
				return { items };
			});
		}
	});

	return { requestRefresh };

	async function requestRefresh(clearDiagnostics: boolean) {
		const req = ++refreshReq;
		const delay = 250;
		await sleep(delay);
		if (req !== refreshReq) {
			return;
		}
		for (const handler of refreshHandlers) {
			handler(clearDiagnostics);
		}
	}

	async function updateDiagnosticsBatch(project: LanguageServerProject, documents: SnapshotDocument[]) {
		const req = ++updateDiagnosticsBatchReq;
		const delay = 250;
		const token: vscode.CancellationToken = {
			get isCancellationRequested() {
				return req !== updateDiagnosticsBatchReq;
			},
			onCancellationRequested: vscode.Event.None,
		};
		for (const doc of documents) {
			await sleep(delay);
			if (token.isCancellationRequested) {
				break;
			}
			await updateDiagnostics(project, URI.parse(doc.uri), doc.version, token);
		}
	}

	async function updateDiagnostics(project: LanguageServerProject, uri: URI, version: number, token: vscode.CancellationToken) {
		const languageService = await project.getLanguageService(uri);
		const diagnostics = await languageService.getDiagnostics(
			uri,
			diagnostics => server.connection.sendDiagnostics({ uri: uri.toString(), diagnostics, version }),
			token
		);
		if (!token.isCancellationRequested) {
			server.connection.sendDiagnostics({ uri: uri.toString(), diagnostics, version });
		}
	}

	function worker<T>(uri: URI, token: vscode.CancellationToken, cb: (languageService: LanguageService) => T) {
		return new Promise<T | undefined>(resolve => {
			setTimeout(async () => {
				if (token.isCancellationRequested) {
					resolve(undefined);
					return;
				}
				const languageService = (await server.project.getLanguageService(decodeEmbeddedDocumentUri(uri)?.[0] ?? uri));
				const result = await cb(languageService);
				if (token.isCancellationRequested) {
					resolve(undefined);
					return;
				}
				resolve(result);
			}, 0);
		});
	}

	function fixTextEdit(initializeParams: vscode.InitializeParams, item: vscode.CompletionItem) {
		const insertReplaceSupport = initializeParams.capabilities.textDocument?.completion?.completionItem?.insertReplaceSupport ?? false;
		if (!insertReplaceSupport) {
			if (item.textEdit && vscode.InsertReplaceEdit.is(item.textEdit)) {
				item.textEdit = vscode.TextEdit.replace(item.textEdit.insert, item.textEdit.newText);
			}
		}
	}
}

function sleep(ms: number) {
	return new Promise(resolve => setTimeout(resolve, ms));
}
