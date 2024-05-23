import type { CodeInformation } from '@volar/language-server';
import { SourceMap, Stack } from '@volar/source-map';
import { LabsInfo, TextDocument } from '@volar/vscode';
import * as vscode from 'vscode';
import { VOLAR_VIRTUAL_CODE_SCHEME } from '../views/virtualFilesView';

const mappingDecorationType = vscode.window.createTextEditorDecorationType({
	borderWidth: '0.5px',
	borderStyle: 'solid',
});
const mappingSelectionDecorationType = vscode.window.createTextEditorDecorationType({
	borderWidth: '1px',
	borderStyle: 'solid',
	borderColor: 'darkorange',
});
const mappingCursorDecorationType = vscode.window.createTextEditorDecorationType({
	borderWidth: '1px',
	borderStyle: 'solid',
	borderColor: 'darkorange',
	backgroundColor: 'darkorange',
});

export const sourceDocUriToVirtualDocUris = new Map<string, Set<string>>();

export const virtualDocUriToSourceDocUri = new Map<string, { fileUri: string, virtualCodeId: string; }>();

export async function activate(extensions: vscode.Extension<LabsInfo>[]) {

	const subscriptions: vscode.Disposable[] = [];
	const docChangeEvent = new vscode.EventEmitter<vscode.Uri>();
	const virtualUriToSourceMap = new Map<string, [string, number, SourceMap<CodeInformation>][]>();
	const virtualUriToStacks = new Map<string, Stack[]>();
	const virtualDocuments = new Map<string, TextDocument>();

	let updateVirtualDocument: ReturnType<typeof setTimeout> | undefined;
	let updateDecorationsTimeout: ReturnType<typeof setTimeout> | undefined;

	subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(updateDecorations),
		vscode.window.onDidChangeTextEditorSelection(updateDecorations),
		vscode.window.onDidChangeVisibleTextEditors(updateDecorations),
		vscode.workspace.onDidChangeTextDocument(e => {
			if (sourceDocUriToVirtualDocUris.has(e.document.uri.toString())) {
				const virtualUris = sourceDocUriToVirtualDocUris.get(e.document.uri.toString());
				clearTimeout(updateVirtualDocument);
				updateVirtualDocument = setTimeout(() => {
					virtualUris?.forEach(uri => {
						docChangeEvent.fire(vscode.Uri.parse(uri));
					});
				}, 100);
			}
		}),
		vscode.languages.registerHoverProvider({ scheme: VOLAR_VIRTUAL_CODE_SCHEME }, {
			async provideHover(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken) {

				const maps = virtualUriToSourceMap.get(document.uri.toString());
				if (!maps) {
					return;
				}

				const data: {
					uri: string,
					mapping: any,
				}[] = [];

				for (const [sourceUri, _, map] of maps) {
					const source = map.getSourceOffset(document.offsetAt(position));
					if (source) {
						data.push({
							uri: sourceUri,
							mapping: source,
						});
					}
				}

				if (data.length === 0) {
					return;
				}

				return new vscode.Hover(data.map(data => [
					data.uri,
					'',
					'',
					'```json',
					JSON.stringify(data.mapping, null, 2),
					'```',
				].join('\n')));
			}
		}),
		vscode.languages.registerDefinitionProvider({ scheme: VOLAR_VIRTUAL_CODE_SCHEME.toLowerCase() }, {
			async provideDefinition(document: vscode.TextDocument, position: vscode.Position, _token: vscode.CancellationToken) {

				const stacks = virtualUriToStacks.get(document.uri.toString());
				if (!stacks) {
					return;
				}

				const offset = document.offsetAt(position);
				const stack = stacks.find(stack => stack.range[0] <= offset && offset <= stack.range[1]);
				if (!stack) {
					return;
				}

				const line = Number(stack.source.split(':').at(-2));
				const character = Number(stack.source.split(':').at(-1));
				const fileName = stack.source.split(':').slice(0, -2).join(':');
				const link: vscode.DefinitionLink = {
					originSelectionRange: new vscode.Range(document.positionAt(stack.range[0]), document.positionAt(stack.range[1])),
					targetUri: vscode.Uri.file(fileName),
					targetRange: new vscode.Range(line - 1, character - 1, line - 1, character - 1),
				};
				return [link];
			}
		}),
		vscode.languages.registerInlayHintsProvider({ scheme: VOLAR_VIRTUAL_CODE_SCHEME.toLowerCase() }, {
			provideInlayHints(document, range) {
				const stacks = virtualUriToStacks.get(document.uri.toString());
				const result: vscode.InlayHint[] = [];
				const range2 = [document.offsetAt(range.start), document.offsetAt(range.end)];
				const text = document.getText();
				for (const stack of stacks ?? []) {
					let [start, end] = stack.range;
					let startText = '[';
					let endText = ']';
					while (end > start && text[end - 1] === '\n') {
						end--;
						endText = '\n' + endText;
					}
					while (start < end && text[start] === '\n') {
						start++;
						startText = '\n' + startText;
					}
					if (start >= range2[0] && start <= range2[1]) {
						result.push(new vscode.InlayHint(document.positionAt(start), startText));
						result[result.length - 1].paddingLeft = true;
					}
					if (end >= range2[0] && end <= range2[1]) {
						result.push(new vscode.InlayHint(document.positionAt(end), endText));
						result[result.length - 1].paddingRight = true;
					}
				}
				return result;
			},
		}),
		vscode.workspace.registerTextDocumentContentProvider(
			VOLAR_VIRTUAL_CODE_SCHEME,
			{
				onDidChange: docChangeEvent.event,
				async provideTextDocumentContent(uri: vscode.Uri): Promise<string | undefined> {

					virtualUriToSourceMap.set(uri.toString(), []);

					const source = virtualDocUriToSourceDocUri.get(uri.toString());
					if (!source) {
						return;
					}

					const clientId = uri.authority;
					const info = extensions.find(extension => extension.exports.volarLabs.languageClients.some(client =>
						// @ts-expect-error
						client._id === clientId
					))?.exports;
					if (!info) {
						return;
					}

					const client = info.volarLabs.languageClients.find(
						// @ts-expect-error
						client => client._id === clientId
					)!;
					const virtualCode = await client.sendRequest(
						info.volarLabs.languageServerProtocol.GetVirtualCodeRequest.type,
						source
					);

					Object.entries(virtualCode.mappings).forEach(([sourceUri, mappings]) => {
						const sourceEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === sourceUri);
						if (sourceEditor) {
							virtualUriToSourceMap.get(uri.toString())?.push([
								sourceEditor.document.uri.toString(),
								sourceEditor.document.version,
								new SourceMap(mappings),
							]);
							if (!sourceDocUriToVirtualDocUris.has(sourceUri)) {
								sourceDocUriToVirtualDocUris.set(sourceUri, new Set());
							}
							sourceDocUriToVirtualDocUris.get(sourceUri)?.add(uri.toString());
						}
					});
					virtualDocuments.set(uri.toString(), TextDocument.create('', '', 0, virtualCode.content));
					virtualUriToStacks.set(uri.toString(), virtualCode.codegenStacks);

					clearTimeout(updateDecorationsTimeout);
					updateDecorationsTimeout = setTimeout(updateDecorations, 100);

					return virtualCode.content;
				}
			},
		),
	);

	return vscode.Disposable.from(...subscriptions);

	function updateDecorations() {
		for (const [_, sources] of virtualUriToSourceMap) {
			for (const [sourceUri] of sources) {
				const sourceEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === sourceUri);
				if (sourceEditor) {
					sourceEditor.setDecorations(mappingDecorationType, []);
					sourceEditor.setDecorations(mappingSelectionDecorationType, []);
					sourceEditor.setDecorations(mappingCursorDecorationType, []);
				}
			}
		}
		for (const [virtualUri, sources] of virtualUriToSourceMap) {

			const virtualEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === virtualUri);
			let virtualRanges1: vscode.Range[] = [];
			let virtualRanges2: vscode.Range[] = [];
			let virtualRanges3: vscode.Range[] = [];

			if (virtualEditor) {
				for (const [sourceUri, sourceVersion, map] of sources) {
					const sourceEditor = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === sourceUri);
					if (sourceEditor && sourceEditor.document.version === sourceVersion) {
						const mappingDecorationRanges = map.mappings
							.map(mapping => mapping.sourceOffsets.map((offset, i) => new vscode.Range(
								sourceEditor.document.positionAt(offset),
								sourceEditor.document.positionAt(offset + mapping.lengths[i]),
							)))
							.flat();
						sourceEditor.setDecorations(mappingDecorationType, mappingDecorationRanges);
						virtualRanges1 = virtualRanges1.concat(
							map.mappings
								.map(mapping => mapping.generatedOffsets.map((offset, i) => new vscode.Range(
									getGeneratedPosition(virtualUri, offset),
									getGeneratedPosition(virtualUri, offset + (mapping.generatedLengths ?? mapping.lengths)[i]),
								)))
								.flat()
						);

						/**
						 * selection
						 */
						if (vscode.window.activeTextEditor) {

							const selection = vscode.window.activeTextEditor.selection;
							const startOffset = vscode.window.activeTextEditor.document.offsetAt(selection.start);
							const endOffset = vscode.window.activeTextEditor.document.offsetAt(selection.end);

							if (vscode.window.activeTextEditor === sourceEditor) {

								const mappedStarts = [...map.getGeneratedOffsets(startOffset)];
								const mappedEnds = [...map.getGeneratedOffsets(endOffset)];

								sourceEditor.setDecorations(
									mappingSelectionDecorationType,
									mappedStarts
										.map(([_, mapping]) => mapping.sourceOffsets.map((offset, i) => new vscode.Range(
											sourceEditor.document.positionAt(offset),
											sourceEditor.document.positionAt(offset + mapping.lengths[i]),
										)))
										.flat()
								);

								virtualRanges2 = virtualRanges2.concat(
									mappedStarts
										.map(([_, mapping]) => mapping.generatedOffsets.map((offset, i) => new vscode.Range(
											getGeneratedPosition(virtualUri, offset),
											getGeneratedPosition(virtualUri, offset + (mapping.generatedLengths ?? mapping.lengths)[i]),
										)))
										.flat()
								);
								virtualRanges3 = virtualRanges3.concat(
									mappedStarts.map(mapped => new vscode.Range(
										getGeneratedPosition(virtualUri, mapped[0]),
										getGeneratedPosition(virtualUri, mappedEnds.find(mapped2 => mapped[1] === mapped2[1])?.[0] ?? mapped[0]),
									))
								);

								if (virtualRanges3.length) {
									virtualEditor.revealRange(virtualRanges3[0]);
								}
							}
							else if (vscode.window.activeTextEditor === virtualEditor) {

								const mappedStarts = [...map.getSourceOffsets(startOffset)];
								const mappedEnds = [...map.getSourceOffsets(endOffset)];

								const sourceRanges2 = mappedStarts
									.map(([_, mapping]) => mapping.sourceOffsets.map((offset, i) => new vscode.Range(
										sourceEditor.document.positionAt(offset),
										sourceEditor.document.positionAt(offset + mapping.lengths[i]),
									)))
									.flat();
								const sourceRanges3 = mappedStarts.map(mapped => new vscode.Range(
									sourceEditor.document.positionAt(mapped[0]),
									sourceEditor.document.positionAt(mappedEnds.find(mapped2 => mapped[1] === mapped2[1])?.[0] ?? mapped[0]),
								));

								sourceEditor.setDecorations(mappingSelectionDecorationType, sourceRanges2);
								sourceEditor.setDecorations(mappingCursorDecorationType, sourceRanges3);

								virtualRanges2 = virtualRanges2.concat(
									mappedStarts
										.map(([_, mapping]) => mapping.generatedOffsets.map((offset, i) => new vscode.Range(
											getGeneratedPosition(virtualUri, offset),
											getGeneratedPosition(virtualUri, offset + (mapping.generatedLengths ?? mapping.lengths)[i]),
										)))
										.flat()
								);

								if (sourceRanges3.length) {
									sourceEditor.revealRange(sourceRanges3[0]);
								}
							}
						}
					}
				}
				virtualEditor.setDecorations(mappingDecorationType, virtualRanges1);
				virtualEditor.setDecorations(mappingSelectionDecorationType, virtualRanges2);
				virtualEditor.setDecorations(mappingCursorDecorationType, virtualRanges3);
			}
		}
	}

	function getGeneratedPosition(virtualUri: string, offset: number) {
		const document = virtualDocuments.get(virtualUri)!;
		const position = document.positionAt(offset);
		return new vscode.Position(position.line, position.character);
	}
}
