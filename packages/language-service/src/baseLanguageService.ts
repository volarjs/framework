import { createLanguageContext } from '@volar/language-core';
import * as shared from '@volar/shared';
import * as tsFaster from '@volar/typescript-faster';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { createDocumentsAndSourceMaps } from './documents';
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
import * as semanticTokens from './languageFeatures/documentSemanticTokens';
import * as fileReferences from './languageFeatures/fileReferences';
import * as fileRename from './languageFeatures/fileRename';
import * as hover from './languageFeatures/hover';
import * as inlayHints from './languageFeatures/inlayHints';
import * as references from './languageFeatures/references';
import * as rename from './languageFeatures/rename';
import * as renamePrepare from './languageFeatures/renamePrepare';
import * as signatureHelp from './languageFeatures/signatureHelp';
import * as diagnostics from './languageFeatures/validation';
import * as workspaceSymbol from './languageFeatures/workspaceSymbols';
import { LanguageServicePluginContext, LanguageServiceOptions } from './types';
import type * as ts from 'typescript/lib/tsserverlibrary';

import * as colorPresentations from './documentFeatures/colorPresentations';
import * as documentColors from './documentFeatures/documentColors';
import * as documentSymbols from './documentFeatures/documentSymbols';
import * as foldingRanges from './documentFeatures/foldingRanges';
import * as format from './documentFeatures/format';
import * as linkedEditingRanges from './documentFeatures/linkedEditingRanges';
import * as selectionRanges from './documentFeatures/selectionRanges';

// fix build
import type * as _ from 'vscode-languageserver-protocol';

export type LanguageService = ReturnType<typeof createLanguageService>;

export function createLanguageService(
	ctx: LanguageServiceOptions,
	documentRegistry?: ts.DocumentRegistry,
) {
	const languageContext = createLanguageContext(ctx.host, Object.values(ctx.config.languages ?? {}).filter(shared.notEmpty));
	const context = createLanguageServiceContext(ctx, languageContext, documentRegistry);
	return createLanguageServiceBase(context);
}

function createLanguageServiceContext(
	ctx: LanguageServiceOptions,
	languageContext: ReturnType<typeof createLanguageContext>,
	documentRegistry?: ts.DocumentRegistry,
) {

	const ts = ctx.host.getTypeScriptModule?.();
	const tsLs = ts?.createLanguageService(languageContext.typescript.languageServiceHost, documentRegistry);

	if (ts && tsLs) {
		tsFaster.decorate(ts, languageContext.typescript.languageServiceHost, tsLs);
	}

	const textDocumentMapper = createDocumentsAndSourceMaps(ctx, languageContext.virtualFiles);
	const documents = new WeakMap<ts.IScriptSnapshot, TextDocument>();
	const documentVersions = new Map<string, number>();
	const context: LanguageServicePluginContext = {
		...ctx,
		core: languageContext,
		plugins: {},
		typescript: ts && tsLs ? {
			module: ts,
			languageServiceHost: languageContext.typescript.languageServiceHost,
			languageService: tsLs,
		} : undefined,
		documents: textDocumentMapper,
		getTextDocument,
	};

	for (const pluginId in ctx.config.plugins ?? {}) {
		const plugin = ctx.config.plugins?.[pluginId];
		if (plugin instanceof Function) {
			const _plugin = plugin(context);
			context.plugins[pluginId] = _plugin;
		}
		else if (plugin) {
			context.plugins[pluginId] = plugin;
		}
	}

	return context;

	function getTextDocument(uri: string) {

		const fileName = ctx.uriToFileName(uri);
		const scriptSnapshot = ctx.host.getScriptSnapshot(fileName);

		if (scriptSnapshot) {

			let document = documents.get(scriptSnapshot);

			if (!document) {

				const newVersion = (documentVersions.get(uri.toLowerCase()) ?? 0) + 1;

				documentVersions.set(uri.toLowerCase(), newVersion);

				document = TextDocument.create(
					uri,
					shared.syntaxToLanguageId(uri.substring(uri.lastIndexOf('.') + 1)),
					newVersion,
					scriptSnapshot.getText(0, scriptSnapshot.getLength()),
				);
				documents.set(scriptSnapshot, document);
			}

			return document;
		}
	}
}

function createLanguageServiceBase(context: LanguageServicePluginContext) {

	return {

		triggerCharacters: Object.values(context.plugins).map(plugin => plugin?.triggerCharacters ?? []).flat(),

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
		findDefinition: definition.register(context, 'provideDefinition', data => !!data.definition, data => !!data.definition),
		findTypeDefinition: definition.register(context, 'provideTypeDefinition', data => !!data.definition, data => !!data.definition),
		findImplementations: definition.register(context, 'provideImplementation', data => !!data.references, () => false),
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
		findWorkspaceSymbols: workspaceSymbol.register(context),
		doAutoInsert: autoInsert.register(context),
		getInlayHints: inlayHints.register(context),
		callHierarchy: callHierarchy.register(context),
		dispose: () => context.typescript?.languageService.dispose(),
		context,
	};
}
