import { MappingKey } from '@volar/language-core';
import type * as vscode from 'vscode-languageserver-protocol';
import type { ServiceContext } from '../types';
import { NoneCancellationToken } from '../utils/cancellation';
import { isInsideRange, notEmpty } from '../utils/common';
import { languageFeatureWorker } from '../utils/featureWorkers';
import { transformSelectionRanges } from '../utils/transform';

export function register(context: ServiceContext) {

	return (uri: string, positions: vscode.Position[], token = NoneCancellationToken) => {

		return languageFeatureWorker(
			context,
			uri,
			() => positions,
			function* (map) {
				if (map.map.codeMappings.some(mapping => mapping[MappingKey.DATA].selectionRanges)) {
					const result = positions
						.map(position => map.toGeneratedPosition(position, data => data.selectionRanges ?? true))
						.filter(notEmpty);
					if (result.length) {
						yield result;
					}
				}
			},
			(service, document, positions) => {

				if (token.isCancellationRequested)
					return;

				return service.provideSelectionRanges?.(document, positions, token);
			},
			(data, map) => {
				if (!map) {
					return data;
				}
				return transformSelectionRanges(
					data,
					range => map.toSourceRange(range, data => data.selectionRanges ?? true)
				);
			},
			results => {
				const result: vscode.SelectionRange[] = [];
				for (let i = 0; i < positions.length; i++) {
					let pluginResults: vscode.SelectionRange[] = [];
					for (const ranges of results) {
						pluginResults.push(ranges[i]);
					}
					pluginResults = pluginResults.sort((a, b) => {
						if (isInsideRange(a.range, b.range)) {
							return 1;
						}
						if (isInsideRange(b.range, a.range)) {
							return -1;
						}
						return 0;
					});
					for (let i = 1; i < pluginResults.length; i++) {
						let root = pluginResults[i - 1];
						while (root.parent) {
							root = root.parent;
						}
						let parent: vscode.SelectionRange | undefined = pluginResults[i];
						while (parent && !isInsideRange(parent.range, root.range)) {
							parent = parent.parent;
						}
						if (parent) {
							root.parent = parent;
						}
					}
					result.push(pluginResults[0]);
				}
				return result;
			},
		);
	};
}
