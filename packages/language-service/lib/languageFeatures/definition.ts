import type * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext } from '../types';
import { languageFeatureWorker } from '../utils/featureWorkers';
import * as dedupe from '../utils/dedupe';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { FileRangeCapabilities, MirrorBehaviorCapabilities } from '@volar/language-core';
import { SourceMapWithDocuments } from '../documents';
import { notEmpty } from '../utils/common';
import { NoneCancellationToken } from '../utils/cancellation';

export function register(
	context: ServiceContext,
	apiName: 'provideDefinition' | 'provideTypeDefinition' | 'provideImplementation',
	isValidMapping: (data: FileRangeCapabilities) => boolean,
	isValidMirrorPosition: (mirrorData: MirrorBehaviorCapabilities) => boolean,
) {

	return (uri: string, position: vscode.Position, token = NoneCancellationToken) => {

		return languageFeatureWorker(
			context,
			uri,
			position,
			(position, map) => map.toGeneratedPositions(position, isValidMapping),
			async (service, document, position) => {

				if (token.isCancellationRequested)
					return;

				const recursiveChecker = dedupe.createLocationSet();
				const result: vscode.LocationLink[] = [];

				await withMirrors(document, position, undefined);

				return result;

				async function withMirrors(document: TextDocument, position: vscode.Position, originDefinition: vscode.LocationLink | undefined) {

					const api = service[apiName];
					if (!api)
						return;

					if (recursiveChecker.has({ uri: document.uri, range: { start: position, end: position } }))
						return;

					recursiveChecker.add({ uri: document.uri, range: { start: position, end: position } });

					const definitions = await api?.(document, position, token) ?? [];

					for (const definition of definitions) {

						let foundMirrorPosition = false;

						recursiveChecker.add({ uri: definition.targetUri, range: { start: definition.targetRange.start, end: definition.targetRange.start } });

						const mirrorMap = context.documents.getMirrorMapByUri(definition.targetUri)?.[1];

						if (mirrorMap) {

							for (const mapped of mirrorMap.findMirrorPositions(definition.targetSelectionRange.start)) {

								if (!isValidMirrorPosition(mapped[1]))
									continue;

								if (recursiveChecker.has({ uri: mirrorMap.document.uri, range: { start: mapped[0], end: mapped[0] } }))
									continue;

								foundMirrorPosition = true;

								await withMirrors(mirrorMap.document, mapped[0], originDefinition ?? definition);
							}
						}

						if (!foundMirrorPosition) {
							if (originDefinition) {
								result.push({
									...definition,
									originSelectionRange: originDefinition.originSelectionRange,
								});
							}
							else {
								result.push(definition);
							}
						}
					}
				}
			},
			(data, sourceMap) => data.map(link => {

				if (link.originSelectionRange && sourceMap) {

					const originSelectionRange = toSourcePositionPreferSurroundedPosition(sourceMap, link.originSelectionRange, position);

					if (!originSelectionRange)
						return;

					link.originSelectionRange = originSelectionRange;
				}

				let foundTargetSelectionRange = false;

				for (const [_, targetSourceMap] of context.documents.getMapsByVirtualFileUri(link.targetUri)) {

					const targetSelectionRange = targetSourceMap.toSourceRange(link.targetSelectionRange);
					if (!targetSelectionRange)
						continue;

					foundTargetSelectionRange = true;

					let targetRange = targetSourceMap.toSourceRange(link.targetRange);

					link.targetUri = targetSourceMap.sourceFileDocument.uri;
					// loose range mapping to for template slots, slot properties
					link.targetRange = targetRange ?? targetSelectionRange;
					link.targetSelectionRange = targetSelectionRange;
				}

				if (apiName === 'provideDefinition' && context.documents.isVirtualFileUri(link.targetUri) && !foundTargetSelectionRange) {
					for (const [_, targetMap] of context.documents.getMapsByVirtualFileUri(link.targetUri)) {
						if (targetMap && targetMap.sourceFileDocument.uri !== uri) {
							return {
								...link,
								targetUri: targetMap.sourceFileDocument.uri,
								targetRange: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
								targetSelectionRange: {
									start: { line: 0, character: 0 },
									end: { line: 0, character: 0 },
								},
							};
						}
					}
					return;
				}

				return link;
			}).filter(notEmpty),
			arr => dedupe.withLocationLinks(arr.flat()),
		);
	};
}

function toSourcePositionPreferSurroundedPosition(map: SourceMapWithDocuments, mappedRange: vscode.Range, position: vscode.Position) {

	let result: vscode.Range | undefined;

	for (const range of map.toSourceRanges(mappedRange)) {
		if (!result) {
			result = range;
		}
		if (
			(range.start.line < position.line || (range.start.line === position.line && range.start.character <= position.character))
			&& (range.end.line > position.line || (range.end.line === position.line && range.end.character >= position.character))
		) {
			return range;
		}
	}

	return result;
}
