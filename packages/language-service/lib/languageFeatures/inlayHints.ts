import type * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext } from '../types';
import { getOverlapRange, notEmpty } from '../utils/common';
import { languageFeatureWorker } from '../utils/featureWorkers';
import { NoneCancellationToken } from '../utils/cancellation';
import { transformTextEdit } from '../utils/transform';

export interface InlayHintData {
	uri: string,
	original: Pick<vscode.CodeAction, 'data' | 'edit'>,
	serviceIndex: number,
}

export function register(context: ServiceContext) {

	return async (uri: string, range: vscode.Range, token = NoneCancellationToken) => {

		const sourceFile = context.project.fileProvider.getSourceFile(uri);
		if (!sourceFile)
			return;

		const document = context.documents.get(uri, sourceFile.languageId, sourceFile.snapshot);
		const offsetRange = {
			start: document.offsetAt(range.start),
			end: document.offsetAt(range.end),
		};

		return languageFeatureWorker(
			context,
			uri,
			() => range,
			function* (map) {

				/**
				 * copy from ./codeActions.ts
				 */

				if (!map.map.mappings.some(mapping => mapping.data.inlayHints ?? true)) {
					return;
				}

				let minStart: number | undefined;
				let maxEnd: number | undefined;

				for (const mapping of map.map.mappings) {
					const overlapRange = getOverlapRange(offsetRange.start, offsetRange.end, mapping.sourceRange[0], mapping.sourceRange[1]);
					if (overlapRange) {
						const start = map.map.toGeneratedOffset(overlapRange.start)?.[0];
						const end = map.map.toGeneratedOffset(overlapRange.end)?.[0];
						if (start !== undefined && end !== undefined) {
							minStart = minStart === undefined ? start : Math.min(start, minStart);
							maxEnd = maxEnd === undefined ? end : Math.max(end, maxEnd);
						}
					}
				}

				if (minStart !== undefined && maxEnd !== undefined) {
					yield {
						start: map.virtualFileDocument.positionAt(minStart),
						end: map.virtualFileDocument.positionAt(maxEnd),
					};
				}
			},
			async (service, document, arg) => {
				if (token.isCancellationRequested) {
					return;
				}
				const hints = await service.provideInlayHints?.(document, arg, token);
				hints?.forEach(link => {
					link.data = {
						uri,
						original: {
							data: link.data,
						},
						serviceIndex: context.services.indexOf(service),
					} satisfies InlayHintData;
				});

				return hints;
			},
			(inlayHints, map) => {
				if (!map) {
					return inlayHints;
				}
				return inlayHints
					.map((_inlayHint): vscode.InlayHint | undefined => {
						const position = map.toSourcePosition(
							_inlayHint.position,
							data => data.inlayHints ?? true,
						);
						const edits = _inlayHint.textEdits
							?.map(textEdit => transformTextEdit(textEdit, range => map!.toSourceRange(range), map.virtualFileDocument))
							.filter(notEmpty);

						if (position) {
							return {
								..._inlayHint,
								position,
								textEdits: edits,
							};
						}
					})
					.filter(notEmpty);
			},
			arr => arr.flat(),
		);
	};
}
