import * as shared from '@volar/shared';
import type { LanguageServicePluginContext } from '../types';
import { languageFeatureWorker } from '../utils/featureWorkers';
import * as vscode from 'vscode-languageserver-protocol';

export interface PluginCodeLensData {
	kind: 'normal',
	uri: string,
	original: Pick<vscode.CodeLens, 'data'>,
	pluginId: string,
}

export interface PluginReferencesCodeLensData {
	kind: 'references',
	uri: string,
	location: vscode.Location,
	pluginId: string,
}

export function register(context: LanguageServicePluginContext) {

	return async (uri: string, token: vscode.CancellationToken) => {

		const referencesCodeLendsEnabled = await context.configurationHost?.getConfiguration<boolean>('volar.codeLens.references') ?? true;

		return await languageFeatureWorker(
			context,
			uri,
			undefined,
			(arg) => [arg],
			async (plugin, document) => {

				if (token.isCancellationRequested)
					return;

				let codeLens = await plugin.provideCodeLenses?.(document, token);

				const pluginId = Object.keys(context.plugins).find(key => context.plugins[key] === plugin)!;

				codeLens?.forEach(codeLens => {
					codeLens.data = {
						kind: 'normal',
						uri,
						original: {
							data: codeLens.data,
						},
						pluginId,
					} satisfies PluginCodeLensData;
				});

				if (referencesCodeLendsEnabled) {

					const referencesCodeLensLocs = await plugin.provideReferencesCodeLenses?.(document, token);
					const referencesCodeLens = referencesCodeLensLocs?.map(loc => vscode.CodeLens.create(loc.range, {
						kind: 'references',
						uri,
						location: loc,
						pluginId,
					} satisfies PluginReferencesCodeLensData));

					codeLens = [
						...codeLens ?? [],
						...referencesCodeLens ?? [],
					];
				}

				return codeLens;
			},
			(data, map) => data.map(codeLens => {

				if (!map)
					return codeLens;

				const range = map.toSourceRange(codeLens.range);
				if (range) {
					return {
						...codeLens,
						range,
					};
				}
			}).filter(shared.notEmpty),
			arr => arr.flat(),
		) ?? [];
	};
}
