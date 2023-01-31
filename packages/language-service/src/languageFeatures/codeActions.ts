import * as shared from '@volar/shared';
import * as transformer from '../transformer';
import * as vscode from 'vscode-languageserver-protocol';
import type { LanguageServiceRuntimeContext } from '../types';
import { getOverlapRange } from '../utils/common';
import * as dedupe from '../utils/dedupe';
import { languageFeatureWorker } from '../utils/featureWorkers';
import { embeddedEditToSourceEdit } from './rename';
import { PluginDiagnosticData } from './validation';

export interface PluginCodeActionData {
	uri: string,
	originalData: any,
	pluginId: string,
	map: {
		embeddedDocumentUri: string;
	} | undefined,
}

export function register(context: LanguageServiceRuntimeContext) {

	return async (uri: string, range: vscode.Range, codeActionContext: vscode.CodeActionContext) => {

		const document = context.getTextDocument(uri);

		if (!document)
			return;

		const offsetRange = {
			start: document.offsetAt(range.start),
			end: document.offsetAt(range.end),
		};

		let codeActions = await languageFeatureWorker(
			context,
			uri,
			{ range, codeActionContext },
			(_arg, map, file) => {

				if (!file.capabilities.codeAction)
					return [];

				const _codeActionContext: vscode.CodeActionContext = {
					diagnostics: transformer.asLocations(
						codeActionContext.diagnostics,
						range => map.toGeneratedRange(range),
					),
					only: codeActionContext.only,
				};

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
					return [{
						range: vscode.Range.create(
							map.virtualFileDocument.positionAt(minStart),
							map.virtualFileDocument.positionAt(maxEnd),
						),
						codeActionContext: _codeActionContext,
					}];
				}

				return [];
			},
			async (plugin, document, { range, codeActionContext }, map) => {

				const pluginId = Object.keys(context.plugins).find(key => context.plugins[key] === plugin);
				const diagnostics = codeActionContext.diagnostics.filter(diagnostic => {
					const data: PluginDiagnosticData | undefined = diagnostic.data;
					return data?.type === 'plugin' && data?.pluginOrRuleId === pluginId;
				}).map(diagnostic => {
					const data: PluginDiagnosticData = diagnostic.data;
					return {
						...diagnostic,
						data: data.originalData,
					};
				});

				const codeActions = await plugin.codeAction?.on?.(document, range, {
					...codeActionContext,
					diagnostics,
				});

				return codeActions?.map<vscode.CodeAction>(_codeAction => {
					return {
						..._codeAction,
						data: {
							uri,
							originalData: _codeAction.data,
							pluginId: Object.keys(context.plugins).find(key => context.plugins[key] === plugin)!,
							map: map ? {
								embeddedDocumentUri: map.virtualFileDocument.uri,
							} : undefined,
						} satisfies PluginCodeActionData,
					};
				});
			},
			(_codeActions, sourceMap) => _codeActions.map(_codeAction => {

				if (!sourceMap)
					return _codeAction;

				if (_codeAction.edit) {
					const edit = embeddedEditToSourceEdit(
						_codeAction.edit,
						context.documents,
					);
					if (edit) {
						_codeAction.edit = edit;
						return _codeAction;
					}
				}
				else {
					return _codeAction;
				}
			}).filter(shared.notEmpty),
			arr => arr.flat(),
		);

		if (codeActions) {
			return dedupe.withCodeAction(codeActions);
		}
	};
}
