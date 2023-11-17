import * as transformer from '../transformer';
import type { FileRangeCapabilities } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import type { Service, ServiceContext } from '../types';
import { visitEmbedded } from '../utils/definePlugin';
import { NoneCancellationToken } from '../utils/cancellation';

export interface ServiceCompletionData {
	uri: string;
	original: Pick<vscode.CompletionItem, 'additionalTextEdits' | 'textEdit' | 'data'>;
	serviceIndex: number;
	virtualDocumentUri: string | undefined;
}

export function register(context: ServiceContext) {

	let cache: {
		uri: string,
		data: {
			virtualDocumentUri: string | undefined,
			service: ReturnType<Service>,
			list: vscode.CompletionList,
		}[],
		mainCompletion: {
			documentUri: string,
		} | undefined,
	} | undefined;

	return async (
		uri: string,
		position: vscode.Position,
		completionContext: vscode.CompletionContext = { triggerKind: 1 satisfies typeof vscode.CompletionTriggerKind.Invoked, },
		token = NoneCancellationToken,
	) => {

		let document: TextDocument | undefined;

		if (
			completionContext?.triggerKind === 3 satisfies typeof vscode.CompletionTriggerKind.TriggerForIncompleteCompletions
			&& cache?.uri === uri
		) {

			for (const cacheData of cache.data) {

				if (!cacheData.list.isIncomplete)
					continue;

				if (cacheData.virtualDocumentUri) {

					const [virtualFile] = context.project.fileProvider.getVirtualFile(cacheData.virtualDocumentUri);
					if (!virtualFile)
						continue;

					for (const map of context.documents.getMapsByVirtualFile(virtualFile)) {

						for (const mapped of map.toGeneratedPositions(position, data => !!data.completion)) {

							if (!cacheData.service.provideCompletionItems)
								continue;

							const embeddedCompletionList = await cacheData.service.provideCompletionItems(map.virtualFileDocument, mapped, completionContext, token);

							if (!embeddedCompletionList) {
								cacheData.list.isIncomplete = false;
								continue;
							}

							cacheData.list = transformer.asCompletionList(
								embeddedCompletionList,
								range => map.toSourceRange(range),
								map.virtualFileDocument,
								(newItem, oldItem) => newItem.data = {
									uri,
									original: {
										additionalTextEdits: oldItem.additionalTextEdits,
										textEdit: oldItem.textEdit,
										data: oldItem.data,
									},
									serviceIndex: context.services.indexOf(cacheData.service),
									virtualDocumentUri: map.virtualFileDocument.uri,
								} satisfies ServiceCompletionData,
							);
						}
					}
				}
				else if (document = context.getTextDocument(uri)) {

					if (!cacheData.service.provideCompletionItems)
						continue;

					const completionList = await cacheData.service.provideCompletionItems(document, position, completionContext, token);

					if (!completionList) {
						cacheData.list.isIncomplete = false;
						continue;
					}

					completionList.items.forEach(item => {
						item.data = {
							uri,
							original: {
								additionalTextEdits: item.additionalTextEdits,
								textEdit: item.textEdit,
								data: item.data,
							},
							serviceIndex: context.services.indexOf(cacheData.service),
							virtualDocumentUri: undefined,
						} satisfies ServiceCompletionData;
					});
				}
			}
		}
		else {

			const rootVirtualFile = context.project.fileProvider.getSourceFile(uri)?.root;

			cache = {
				uri,
				data: [],
				mainCompletion: undefined,
			};

			// monky fix https://github.com/johnsoncodehk/volar/issues/1358
			let isFirstMapping = true;

			if (rootVirtualFile) {

				await visitEmbedded(context, rootVirtualFile, async (_, map) => {

					const services = [...context.services].sort(sortServices);

					let _data: FileRangeCapabilities | undefined;

					for (const mapped of map.toGeneratedPositions(position, data => {
						_data = data;
						return !!data.completion;
					})) {

						for (const service of services) {

							if (token.isCancellationRequested)
								break;

							if (!service.provideCompletionItems)
								continue;

							if (service.isAdditionalCompletion && !isFirstMapping)
								continue;

							if (completionContext?.triggerCharacter && !service.triggerCharacters?.includes(completionContext.triggerCharacter))
								continue;

							const isAdditional = _data && typeof _data.completion === 'object' && _data.completion.additional || service.isAdditionalCompletion;

							if (cache!.mainCompletion && (!isAdditional || cache?.mainCompletion.documentUri !== map.virtualFileDocument.uri))
								continue;

							// avoid duplicate items with .vue and .vue.html
							if (service.isAdditionalCompletion && cache?.data.some(data => data.service === service))
								continue;

							const embeddedCompletionList = await service.provideCompletionItems(map.virtualFileDocument, mapped, completionContext!, token);

							if (!embeddedCompletionList || !embeddedCompletionList.items.length)
								continue;

							if (typeof _data?.completion === 'object' && _data.completion.autoImportOnly) {
								embeddedCompletionList.items = embeddedCompletionList.items.filter(item => !!item.labelDetails);
							}

							if (!isAdditional) {
								cache!.mainCompletion = { documentUri: map.virtualFileDocument.uri };
							}

							const completionList = transformer.asCompletionList(
								embeddedCompletionList,
								range => map.toSourceRange(range),
								map.virtualFileDocument,
								(newItem, oldItem) => newItem.data = {
									uri,
									original: {
										additionalTextEdits: oldItem.additionalTextEdits,
										textEdit: oldItem.textEdit,
										data: oldItem.data,
									},
									serviceIndex: context.services.indexOf(service),
									virtualDocumentUri: map.virtualFileDocument.uri,
								} satisfies ServiceCompletionData,
							);

							cache!.data.push({
								virtualDocumentUri: map.virtualFileDocument.uri,
								service: service,
								list: completionList,
							});
						}

						isFirstMapping = false;
					}

					return true;
				});
			}

			if (document = context.getTextDocument(uri)) {

				const services = [...context.services].sort(sortServices);

				for (const service of services) {

					if (token.isCancellationRequested)
						break;

					if (!service.provideCompletionItems)
						continue;

					if (service.isAdditionalCompletion && !isFirstMapping)
						continue;

					if (completionContext?.triggerCharacter && !service.triggerCharacters?.includes(completionContext.triggerCharacter))
						continue;

					if (cache.mainCompletion && (!service.isAdditionalCompletion || cache.mainCompletion.documentUri !== document.uri))
						continue;

					// avoid duplicate items with .vue and .vue.html
					if (service.isAdditionalCompletion && cache?.data.some(data => data.service === service))
						continue;

					const completionList = await service.provideCompletionItems(document, position, completionContext, token);

					if (!completionList || !completionList.items.length)
						continue;

					if (!service.isAdditionalCompletion) {
						cache.mainCompletion = { documentUri: document.uri };
					}

					completionList.items.forEach(item => {
						item.data = {
							uri,
							original: {
								additionalTextEdits: item.additionalTextEdits,
								textEdit: item.textEdit,
								data: item.data,
							},
							serviceIndex: context.services.indexOf(service),
							virtualDocumentUri: undefined,
						} satisfies ServiceCompletionData;
					});

					cache.data.push({
						virtualDocumentUri: undefined,
						service: service,
						list: completionList,
					});
				}
			}
		}

		return combineCompletionList(cache.data.map(cacheData => cacheData.list));

		function sortServices(a: ReturnType<Service>, b: ReturnType<Service>) {
			return (b.isAdditionalCompletion ? -1 : 1) - (a.isAdditionalCompletion ? -1 : 1);
		}

		function combineCompletionList(lists: vscode.CompletionList[]): vscode.CompletionList {
			return {
				isIncomplete: lists.some(list => list.isIncomplete),
				itemDefaults: lists.find(list => list.itemDefaults)?.itemDefaults,
				items: lists.map(list => list.items).flat(),
			};
		}
	};
}
