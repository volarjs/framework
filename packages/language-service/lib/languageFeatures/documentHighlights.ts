import type * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext } from '../types';
import { languageFeatureWorker } from '../utils/featureWorkers';
import type { TextDocument } from 'vscode-languageserver-textdocument';
import * as dedupe from '../utils/dedupe';
import { notEmpty } from '../utils/common';
import { NoneCancellationToken } from '../utils/cancellation';
import { isHighlightEnabled } from '@volar/language-core';

export function register(context: ServiceContext) {

	return (uri: string, position: vscode.Position, token = NoneCancellationToken) => {

		return languageFeatureWorker(
			context,
			uri,
			() => position,
			map => map.toGeneratedPositions(position, isHighlightEnabled),
			async (service, document, position) => {

				if (token.isCancellationRequested) {
					return;
				}

				const recursiveChecker = dedupe.createLocationSet();
				const result: vscode.DocumentHighlight[] = [];

				await withMirrors(document, position);

				return result;

				async function withMirrors(document: TextDocument, position: vscode.Position) {

					if (!service.provideDocumentHighlights)
						return;

					if (recursiveChecker.has({ uri: document.uri, range: { start: position, end: position } }))
						return;

					recursiveChecker.add({ uri: document.uri, range: { start: position, end: position } });

					const references = await service.provideDocumentHighlights(document, position, token) ?? [];

					for (const reference of references) {

						let foundMirrorPosition = false;

						recursiveChecker.add({ uri: document.uri, range: { start: reference.range.start, end: reference.range.start } });

						const [virtualFile] = context.project.fileProvider.getVirtualFile(document.uri);
						const mirrorMap = virtualFile ? context.documents.getMirrorMap(virtualFile) : undefined;

						if (mirrorMap) {

							for (const mapped of mirrorMap.findMirrorPositions(reference.range.start)) {

								if (!(mapped[1].highlight ?? true))
									continue;

								if (recursiveChecker.has({ uri: mirrorMap.document.uri, range: { start: mapped[0], end: mapped[0] } }))
									continue;

								foundMirrorPosition = true;

								await withMirrors(mirrorMap.document, mapped[0]);
							}
						}

						if (!foundMirrorPosition) {
							result.push(reference);
						}
					}
				}
			},
			(data, map) => data
				.map(highlight => {

					if (!map)
						return highlight;

					const range = map.toSourceRange(highlight.range, isHighlightEnabled);
					if (range) {
						return {
							...highlight,
							range,
						};
					}
				})
				.filter(notEmpty),
			arr => arr.flat(),
		);
	};
}
