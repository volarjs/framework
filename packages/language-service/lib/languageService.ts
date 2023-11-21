import { CodeInformation, Project } from '@volar/language-core';
import { createDocumentProvider } from './documents';
import * as autoInsert from './languageFeatures/autoInsert';
import * as callHierarchy from './languageFeatures/callHierarchy';
import * as codeActionResolve from './languageFeatures/codeActionResolve';
import * as codeActions from './languageFeatures/codeActions';
import * as codeLens from './languageFeatures/codeLens';
import * as codeLensResolve from './languageFeatures/codeLensResolve';
import * as completions from './languageFeatures/complete';
import * as completionResolve from './languageFeatures/completeResolve';
import * as definition from './languageFeatures/definition';
import * as documentHighlight from './languageFeatures/documentHighlights';
import * as documentLink from './languageFeatures/documentLinks';
import * as documentLinkResolve from './languageFeatures/documentLinkResolve';
import * as semanticTokens from './languageFeatures/documentSemanticTokens';
import * as fileReferences from './languageFeatures/fileReferences';
import * as fileRename from './languageFeatures/fileRename';
import * as hover from './languageFeatures/hover';
import * as inlayHints from './languageFeatures/inlayHints';
import * as inlayHintResolve from './languageFeatures/inlayHintResolve';
import * as references from './languageFeatures/references';
import * as rename from './languageFeatures/rename';
import * as renamePrepare from './languageFeatures/renamePrepare';
import * as signatureHelp from './languageFeatures/signatureHelp';
import * as diagnostics from './languageFeatures/validation';
import * as workspaceSymbol from './languageFeatures/workspaceSymbols';
import { Service, ServiceContext, ServiceEnvironment, SharedModules } from './types';

import * as colorPresentations from './documentFeatures/colorPresentations';
import * as documentColors from './documentFeatures/documentColors';
import * as documentSymbols from './documentFeatures/documentSymbols';
import * as foldingRanges from './documentFeatures/foldingRanges';
import * as format from './documentFeatures/format';
import * as linkedEditingRanges from './documentFeatures/linkedEditingRanges';
import * as selectionRanges from './documentFeatures/selectionRanges';
import type * as vscode from 'vscode-languageserver-protocol';

export type LanguageService = ReturnType<typeof createLanguageService>;

export function createLanguageService(
	modules: SharedModules,
	services: Service[],
	env: ServiceEnvironment,
	project: Project,
) {

	const context = createServiceContext();

	return {

		getTriggerCharacters: () => context.services.map(service => service.triggerCharacters ?? []).flat(),
		getAutoFormatTriggerCharacters: () => context.services.map(service => service.autoFormatTriggerCharacters ?? []).flat(),
		getSignatureHelpTriggerCharacters: () => context.services.map(service => service.signatureHelpTriggerCharacters ?? []).flat(),
		getSignatureHelpRetriggerCharacters: () => context.services.map(service => service.signatureHelpRetriggerCharacters ?? []).flat(),

		format: format.register(context),
		getFoldingRanges: foldingRanges.register(context),
		getSelectionRanges: selectionRanges.register(context),
		findLinkedEditingRanges: linkedEditingRanges.register(context),
		findDocumentSymbols: documentSymbols.register(context),
		findDocumentColors: documentColors.register(context),
		getColorPresentations: colorPresentations.register(context),

		doValidation: diagnostics.register(context),
		findReferences: references.register(context),
		findFileReferences: fileReferences.register(context),
		findDefinition: definition.register(context, 'provideDefinition', data => data.definitions ?? true, data => data.definition ?? true),
		findTypeDefinition: definition.register(context, 'provideTypeDefinition', data => data.definitions ?? true, data => data.definition ?? true),
		findImplementations: definition.register(context, 'provideImplementation', data => data.references ?? true, () => false),
		prepareRename: renamePrepare.register(context),
		doRename: rename.register(context),
		getEditsForFileRename: fileRename.register(context),
		getSemanticTokens: semanticTokens.register(context),
		doHover: hover.register(context),
		doComplete: completions.register(context),
		doCodeActions: codeActions.register(context),
		doCodeActionResolve: codeActionResolve.register(context),
		doCompletionResolve: completionResolve.register(context),
		getSignatureHelp: signatureHelp.register(context),
		doCodeLens: codeLens.register(context),
		doCodeLensResolve: codeLensResolve.register(context),
		findDocumentHighlights: documentHighlight.register(context),
		findDocumentLinks: documentLink.register(context),
		doDocumentLinkResolve: documentLinkResolve.register(context),
		findWorkspaceSymbols: workspaceSymbol.register(context),
		doAutoInsert: autoInsert.register(context),
		getInlayHints: inlayHints.register(context),
		doInlayHintResolve: inlayHintResolve.register(context),
		callHierarchy: callHierarchy.register(context),
		dispose: () => context.services.forEach(service => service.dispose?.()),
		context,
	};

	function createServiceContext() {

		const documents = createDocumentProvider(project.fileProvider);
		const context: ServiceContext = {
			env,
			project,
			inject: (key, ...args) => {
				for (const service of context.services) {
					const provide = service.provide?.[key as any];
					if (provide) {
						return provide(...args as any);
					}
				}
				throw `No service provide ${key as any}`;
			},
			services: [],
			documents: documents,
			commands: {
				rename: {
					create(uri, position) {
						const source = toSourceLocation(
							uri,
							position,
							data => typeof data.renameEdits === 'object'
								? data.renameEdits.shouldRename
								: (data.renameEdits ?? true)
						);
						if (!source) {
							return;
						}
						return {
							title: '',
							command: 'editor.action.rename',
							arguments: [
								source.uri,
								source.position,
							],
						};
					},
					is(command) {
						return command.command === 'editor.action.rename';
					},
				},
				showReferences: {
					create(uri, position, locations) {
						const source = toSourceLocation(uri, position);
						if (!source) {
							return;
						}
						const sourceReferences: vscode.Location[] = [];
						for (const reference of locations) {
							const [virtualFile] = context.project.fileProvider.getVirtualFile(reference.uri);
							if (virtualFile) {
								for (const map of context.documents.getMaps(virtualFile)) {
									const range = map.toSourceRange(reference.range);
									if (range) {
										sourceReferences.push({ uri: map.sourceFileDocument.uri, range });
									}
								}
							}
							else {
								sourceReferences.push(reference);
							}
						}
						return {
							title: locations.length === 1 ? '1 reference' : `${locations.length} references`,
							command: 'editor.action.showReferences',
							arguments: [
								source.uri,
								source.position,
								sourceReferences,
							],
						};
					},
					is(command) {
						return command.command === 'editor.action.showReferences';
					},
				},
				setSelection: {
					create(position: vscode.Position) {
						return {
							title: '',
							command: 'setSelection',
							arguments: [{
								selection: {
									selectionStartLineNumber: position.line + 1,
									positionLineNumber: position.line + 1,
									selectionStartColumn: position.character + 1,
									positionColumn: position.character + 1,
								},
							}],
						};
					},
					is(command) {
						return command.command === 'setSelection';
					}
				},
			},
		};

		for (const service of services) {
			context.services.push(service(context, modules));
		}

		return context;

		function toSourceLocation(uri: string, position: vscode.Position, filter?: (data: CodeInformation) => boolean) {

			const [virtualFile] = project.fileProvider.getVirtualFile(uri);

			if (!virtualFile) {
				return { uri, position };
			}

			for (const map of context.documents.getMaps(virtualFile)) {
				const sourcePosition = map.toSourcePosition(position, filter);
				if (sourcePosition) {
					return {
						uri: map.sourceFileDocument.uri,
						position: sourcePosition,
					};
				}
			}
		}
	}
}
