import type { NullableProviderResult, ServiceContext } from '../types';
import { documentFeatureWorker } from '../utils/featureWorkers';
import * as dedupe from '../utils/dedupe';
import type * as vscode from 'vscode-languageserver-protocol';
import { notEmpty } from '../utils/common';
import { NoneCancellationToken } from '../utils/cancellation';
import { isReferencesEnabled } from '@volar/language-core';

export function register(context: ServiceContext) {

	return (uri: string, token = NoneCancellationToken): NullableProviderResult<vscode.Location[]> => {

		return documentFeatureWorker(
			context,
			uri,
			() => true,
			async (service, document) => {
				if (token.isCancellationRequested) {
					return;
				}
				return await service[1].provideFileReferences?.(document, token) ?? [];
			},
			data => data
				.map(reference => {

					const decoded = context.decodeEmbeddedDocumentUri(reference.uri);
					const sourceScript = decoded && context.language.scripts.get(decoded[0]);
					const virtualCode = decoded && sourceScript?.generated?.embeddedCodes.get(decoded[1]);

					if (!virtualCode) {
						return reference;
					}

					for (const map of context.documents.getMaps(virtualCode)) {
						const range = map.getSourceRange(reference.range, isReferencesEnabled);
						if (range) {
							reference.uri = map.sourceDocument.uri;
							reference.range = range;
							return reference;
						}
					}
				})
				.filter(notEmpty),
			arr => dedupe.withLocations(arr.flat()),
		);
	};
}
