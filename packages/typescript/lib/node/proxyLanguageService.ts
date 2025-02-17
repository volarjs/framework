import {
	CodeInformation,
	Language,
	isCallHierarchyEnabled,
	isCodeActionsEnabled,
	isCompletionEnabled,
	isDefinitionEnabled,
	isFormattingEnabled,
	isHighlightEnabled,
	isHoverEnabled,
	isImplementationEnabled,
	isInlayHintsEnabled,
	isLinkedEditingEnabled,
	isReferencesEnabled,
	isRenameEnabled,
	isSemanticTokensEnabled,
	isSignatureHelpEnabled,
	isTypeDefinitionEnabled,
} from '@volar/language-core';
import type * as ts from 'typescript';
import { dedupeDocumentSpans } from './dedupe';
import {
	getMappingOffset,
	toGeneratedOffset,
	toGeneratedOffsets,
	toGeneratedRanges,
	toSourceOffset,
	toSourceRanges,
	transformCallHierarchyItem,
	transformDiagnostic,
	transformDocumentSpan,
	transformFileTextChanges,
	transformSpan,
	transformTextChange,
	transformTextSpan,
} from './transform';
import { getServiceScript } from './utils';

const windowsPathReg = /\\/g;

/**
 * Creates and returns a Proxy around the base TypeScript LanguageService.
 *
 * This is used by the Volar TypeScript Plugin (which can be created by `createLanguageServicePlugin`
 * and `createAsyncLanguageServicePlugin`) as an adapter layer between the TypeScript Language Service
 * plugin API (see https://github.com/microsoft/TypeScript/wiki/Writing-a-Language-Service-Plugin)
 * and a Volar `Language`.
 *
 * Once the `initialize` method is called, the proxy will begin intercepting requests and
 * enhancing the default behavior of the LanguageService with enhancements based on
 * the Volar `Language` that has been passed to `initialize`.
 */
export function createProxyLanguageService(languageService: ts.LanguageService) {
	const proxyCache = new Map<string | symbol, Function | undefined>();
	let getProxyMethod: ((target: ts.LanguageService, p: string | symbol) => Function | undefined) | undefined;

	return {
		initialize(language: Language<string>) {
			getProxyMethod = (target, p) => {
				switch (p) {
					case 'getNavigationTree': return getNavigationTree(language, target[p]);
					case 'getOutliningSpans': return getOutliningSpans(language, target[p]);
					case 'getFormattingEditsForDocument': return getFormattingEditsForDocument(language, target[p]);
					case 'getFormattingEditsForRange': return getFormattingEditsForRange(language, target[p]);
					case 'getFormattingEditsAfterKeystroke': return getFormattingEditsAfterKeystroke(language, target[p]);
					case 'getEditsForFileRename': return getEditsForFileRename(language, target[p]);
					case 'getLinkedEditingRangeAtPosition': return getLinkedEditingRangeAtPosition(language, target[p]);
					case 'prepareCallHierarchy': return prepareCallHierarchy(language, target[p]);
					case 'provideCallHierarchyIncomingCalls': return provideCallHierarchyIncomingCalls(language, target[p]);
					case 'provideCallHierarchyOutgoingCalls': return provideCallHierarchyOutgoingCalls(language, target[p]);
					case 'organizeImports': return organizeImports(language, target[p]);
					case 'getQuickInfoAtPosition': return getQuickInfoAtPosition(language, target[p]);
					case 'getSignatureHelpItems': return getSignatureHelpItems(language, target[p]);
					case 'getDocumentHighlights': return getDocumentHighlights(language, target[p]);
					case 'getApplicableRefactors': return getApplicableRefactors(language, target[p]);
					case 'getEditsForRefactor': return getEditsForRefactor(language, target[p]);
					case 'getCombinedCodeFix': return getCombinedCodeFix(language, target[p]);
					case 'getRenameInfo': return getRenameInfo(language, target[p]);
					case 'getCodeFixesAtPosition': return getCodeFixesAtPosition(language, target[p]);
					case 'getEncodedSemanticClassifications': return getEncodedSemanticClassifications(language, target[p]);
					case 'getSyntacticDiagnostics': return getSyntacticDiagnostics(language, languageService, target[p]);
					case 'getSemanticDiagnostics': return getSemanticDiagnostics(language, languageService, target[p]);
					case 'getSuggestionDiagnostics': return getSuggestionDiagnostics(language, languageService, target[p]);
					case 'getDefinitionAndBoundSpan': return getDefinitionAndBoundSpan(language, target[p]);
					case 'findReferences': return findReferences(language, target[p]);
					case 'getDefinitionAtPosition': return getDefinitionAtPosition(language, target[p]);
					case 'getTypeDefinitionAtPosition': return getTypeDefinitionAtPosition(language, target[p]);
					case 'getImplementationAtPosition': return getImplementationAtPosition(language, target[p]);
					case 'findRenameLocations': return findRenameLocations(language, target[p]);
					case 'getReferencesAtPosition': return getReferencesAtPosition(language, target[p]);
					case 'getCompletionsAtPosition': return getCompletionsAtPosition(language, target[p]);
					case 'getCompletionEntryDetails': return getCompletionEntryDetails(language, target[p]);
					case 'provideInlayHints': return provideInlayHints(language, target[p]);
					case 'getFileReferences': return getFileReferences(language, target[p]);
					case 'getNavigateToItems': return getNavigateToItems(language, target[p]);
				}
			};
		},
		proxy: new Proxy(languageService, {
			get(target, p, receiver) {
				if (getProxyMethod) {
					if (!proxyCache.has(p)) {
						proxyCache.set(p, getProxyMethod(target, p));
					}
					const proxyMethod = proxyCache.get(p);
					if (proxyMethod) {
						return proxyMethod;
					}
				}
				return Reflect.get(target, p, receiver);
			},
			set(target, p, value, receiver) {
				return Reflect.set(target, p, value, receiver);
			},
		}),
	};
}

// ignored methods

function getNavigationTree(language: Language<string>, getNavigationTree: ts.LanguageService['getNavigationTree']): ts.LanguageService['getNavigationTree'] {
	return filePath => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript] = getServiceScript(language, fileName);
		if (serviceScript || targetScript?.associatedOnly) {
			const tree = getNavigationTree(targetScript.id);
			tree.childItems = undefined;
			return tree;
		}
		else {
			return getNavigationTree(fileName);
		}
	};
}
function getOutliningSpans(language: Language<string>, getOutliningSpans: ts.LanguageService['getOutliningSpans']): ts.LanguageService['getOutliningSpans'] {
	return filePath => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript] = getServiceScript(language, fileName);
		if (serviceScript || targetScript?.associatedOnly) {
			return [];
		}
		else {
			return getOutliningSpans(fileName);
		}
	};
}

// proxy methods

function getFormattingEditsForDocument(language: Language<string>, getFormattingEditsForDocument: ts.LanguageService['getFormattingEditsForDocument']): ts.LanguageService['getFormattingEditsForDocument'] {
	return (filePath, options) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			const map = language.maps.get(serviceScript.code, targetScript);
			if (!map.mappings.some(mapping => isFormattingEnabled(mapping.data))) {
				return [];
			}
			const edits = getFormattingEditsForDocument(targetScript.id, options);
			return edits
				.map(edit => transformTextChange(sourceScript, language, serviceScript, edit, false, isFormattingEnabled)?.[1])
				.filter(edit => !!edit);
		}
		else {
			return getFormattingEditsForDocument(fileName, options);
		}
	};
}
function getFormattingEditsForRange(language: Language<string>, getFormattingEditsForRange: ts.LanguageService['getFormattingEditsForRange']): ts.LanguageService['getFormattingEditsForRange'] {
	return (filePath, start, end, options) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			const generateStart = toGeneratedOffset(language, serviceScript, sourceScript, start, isFormattingEnabled);
			const generateEnd = toGeneratedOffset(language, serviceScript, sourceScript, end, isFormattingEnabled);
			if (generateStart !== undefined && generateEnd !== undefined) {
				const edits = getFormattingEditsForRange(targetScript.id, generateStart, generateEnd, options);
				return edits
					.map(edit => transformTextChange(sourceScript, language, serviceScript, edit, false, isFormattingEnabled)?.[1])
					.filter(edit => !!edit);
			}
			return [];
		}
		else {
			return getFormattingEditsForRange(fileName, start, end, options);
		}
	};
}
function getFormattingEditsAfterKeystroke(language: Language<string>, getFormattingEditsAfterKeystroke: ts.LanguageService['getFormattingEditsAfterKeystroke']): ts.LanguageService['getFormattingEditsAfterKeystroke'] {
	return (filePath, position, key, options) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isFormattingEnabled);
			if (generatePosition !== undefined) {
				const edits = getFormattingEditsAfterKeystroke(targetScript.id, generatePosition, key, options);
				return edits
					.map(edit => transformTextChange(sourceScript, language, serviceScript, edit, false, isFormattingEnabled)?.[1])
					.filter(edit => !!edit);
			}
			return [];
		}
		else {
			return getFormattingEditsAfterKeystroke(fileName, position, key, options);
		}
	};
}
function getEditsForFileRename(language: Language<string>, getEditsForFileRename: ts.LanguageService['getEditsForFileRename']): ts.LanguageService['getEditsForFileRename'] {
	return (oldFilePath, newFilePath, formatOptions, preferences) => {
		const edits = getEditsForFileRename(oldFilePath, newFilePath, formatOptions, preferences);
		return transformFileTextChanges(language, edits, false, isRenameEnabled);
	};
}
function getLinkedEditingRangeAtPosition(language: Language<string>, getLinkedEditingRangeAtPosition: ts.LanguageService['getLinkedEditingRangeAtPosition']): ts.LanguageService['getLinkedEditingRangeAtPosition'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isLinkedEditingEnabled);
			if (generatePosition !== undefined) {
				const info = getLinkedEditingRangeAtPosition(targetScript.id, generatePosition);
				if (info) {
					return {
						ranges: info.ranges
							.map(span => transformTextSpan(sourceScript, language, serviceScript, span, false, isLinkedEditingEnabled)?.[1])
							.filter(span => !!span),
						wordPattern: info.wordPattern,
					};
				}
			}
		}
		else {
			return getLinkedEditingRangeAtPosition(fileName, position);
		}
	};
}
function prepareCallHierarchy(language: Language<string>, prepareCallHierarchy: ts.LanguageService['prepareCallHierarchy']): ts.LanguageService['prepareCallHierarchy'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isCallHierarchyEnabled);
			if (generatePosition !== undefined) {
				const item = prepareCallHierarchy(targetScript.id, generatePosition);
				if (Array.isArray(item)) {
					return item.map(item => transformCallHierarchyItem(language, item, true, isCallHierarchyEnabled));
				}
				else if (item) {
					return transformCallHierarchyItem(language, item, true, isCallHierarchyEnabled);
				}
			}
		}
		else {
			return prepareCallHierarchy(fileName, position);
		}
	};
}
function provideCallHierarchyIncomingCalls(language: Language<string>, provideCallHierarchyIncomingCalls: ts.LanguageService['provideCallHierarchyIncomingCalls']): ts.LanguageService['provideCallHierarchyIncomingCalls'] {
	return (filePath, position) => {
		let calls: ts.CallHierarchyIncomingCall[] = [];
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isCallHierarchyEnabled);
			if (generatePosition !== undefined) {
				calls = provideCallHierarchyIncomingCalls(targetScript.id, generatePosition);
			}
		}
		else {
			calls = provideCallHierarchyIncomingCalls(fileName, position);
		}
		return calls
			.map(call => {
				const from = transformCallHierarchyItem(language, call.from, true, isCallHierarchyEnabled);
				const fromSpans = call.fromSpans
					.map(span => transformSpan(language, call.from.file, span, true, isCallHierarchyEnabled)?.textSpan)
					.filter(span => !!span);
				return {
					from,
					fromSpans,
				};
			});
	};
}
function provideCallHierarchyOutgoingCalls(language: Language<string>, provideCallHierarchyOutgoingCalls: ts.LanguageService['provideCallHierarchyOutgoingCalls']): ts.LanguageService['provideCallHierarchyOutgoingCalls'] {
	return (filePath, position) => {
		let calls: ts.CallHierarchyOutgoingCall[] = [];
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isCallHierarchyEnabled);
			if (generatePosition !== undefined) {
				calls = provideCallHierarchyOutgoingCalls(targetScript.id, generatePosition);
			}
		}
		else {
			calls = provideCallHierarchyOutgoingCalls(fileName, position);
		}
		return calls
			.map(call => {
				const to = transformCallHierarchyItem(language, call.to, true, isCallHierarchyEnabled);
				const fromSpans = call.fromSpans
					.map(span => serviceScript
						? transformTextSpan(sourceScript, language, serviceScript, span, true, isCallHierarchyEnabled)?.[1]
						: span
					)
					.filter(span => !!span);
				return {
					to,
					fromSpans,
				};
			});
	};
}
function organizeImports(language: Language<string>, organizeImports: ts.LanguageService['organizeImports']): ts.LanguageService['organizeImports'] {
	return (args, formatOptions, preferences) => {
		const unresolved = organizeImports(args, formatOptions, preferences);
		return transformFileTextChanges(language, unresolved, false, isCodeActionsEnabled);
	};
}
function getQuickInfoAtPosition(language: Language<string>, getQuickInfoAtPosition: ts.LanguageService['getQuickInfoAtPosition']): ts.LanguageService['getQuickInfoAtPosition'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			const infos: ts.QuickInfo[] = [];
			for (const [generatePosition] of toGeneratedOffsets(language, serviceScript, sourceScript, position, isHoverEnabled)) {
				const info = getQuickInfoAtPosition(targetScript.id, generatePosition);
				if (info) {
					const textSpan = transformTextSpan(sourceScript, language, serviceScript, info.textSpan, true, isHoverEnabled)?.[1];
					if (textSpan) {
						infos.push({
							...info,
							textSpan: textSpan,
						});
					}
				}
			}
			if (infos.length === 1) {
				return infos[0];
			}
			else if (infos.length >= 2) {
				const combine = { ...infos[0] };
				combine.displayParts = combine.displayParts?.slice();
				combine.documentation = combine.documentation?.slice();
				combine.tags = combine.tags?.slice();
				const displayPartsStrs = new Set([displayPartsToString(infos[0].displayParts)]);
				const documentationStrs = new Set([displayPartsToString(infos[0].documentation)]);
				const tagsStrs = new Set<string>();
				for (const tag of infos[0].tags ?? []) {
					tagsStrs.add(tag.name + '__volar__' + displayPartsToString(tag.text));
				}
				for (let i = 1; i < infos.length; i++) {
					const { displayParts, documentation, tags } = infos[i];
					if (displayParts?.length && !displayPartsStrs.has(displayPartsToString(displayParts))) {
						displayPartsStrs.add(displayPartsToString(displayParts));
						combine.displayParts ??= [];
						combine.displayParts.push({ ...displayParts[0], text: '\n\n' + displayParts[0].text });
						combine.displayParts.push(...displayParts.slice(1));
					}
					if (documentation?.length && !documentationStrs.has(displayPartsToString(documentation))) {
						documentationStrs.add(displayPartsToString(documentation));
						combine.documentation ??= [];
						combine.documentation.push({ ...documentation[0], text: '\n\n' + documentation[0].text });
						combine.documentation.push(...documentation.slice(1));
					}
					for (const tag of tags ?? []) {
						if (!tagsStrs.has(tag.name + '__volar__' + displayPartsToString(tag.text))) {
							tagsStrs.add(tag.name + '__volar__' + displayPartsToString(tag.text));
							combine.tags ??= [];
							combine.tags.push(tag);
						}
					}
				}
				return combine;
			}
		}
		else {
			return getQuickInfoAtPosition(fileName, position);
		}
	};
}
function getSignatureHelpItems(language: Language<string>, getSignatureHelpItems: ts.LanguageService['getSignatureHelpItems']): ts.LanguageService['getSignatureHelpItems'] {
	return (filePath, position, options) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isSignatureHelpEnabled);
			if (generatePosition !== undefined) {
				const result = getSignatureHelpItems(targetScript.id, generatePosition, options);
				if (result) {
					const applicableSpan = transformTextSpan(sourceScript, language, serviceScript, result.applicableSpan, true, isSignatureHelpEnabled)?.[1];
					if (applicableSpan) {
						return {
							...result,
							applicableSpan,
						};
					}
				}
			}
		}
		else {
			return getSignatureHelpItems(fileName, position, options);
		}
	};
}
function getDocumentHighlights(language: Language<string>, getDocumentHighlights: ts.LanguageService['getDocumentHighlights']): ts.LanguageService['getDocumentHighlights'] {
	return (filePath, position, filesToSearch) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isHighlightEnabled,
			(fileName, position) => getDocumentHighlights(fileName, position, filesToSearch),
			function* (result) {
				for (const ref of result) {
					for (const reference of ref.highlightSpans) {
						yield [reference.fileName ?? ref.fileName, reference.textSpan.start];
					}
				}
			}
		);
		const resolved = unresolved
			.flat()
			.map(highlights => {
				return {
					...highlights,
					highlightSpans: highlights.highlightSpans
						.map(span => {
							const { textSpan } = transformSpan(language, span.fileName ?? highlights.fileName, span.textSpan, false, isHighlightEnabled) ?? {};
							if (textSpan) {
								return {
									...span,
									contextSpan: transformSpan(language, span.fileName ?? highlights.fileName, span.contextSpan, false, isHighlightEnabled)?.textSpan,
									textSpan,
								};
							}
						})
						.filter(span => !!span),
				};
			});
		return resolved;
	};
}
function getApplicableRefactors(language: Language<string>, getApplicableRefactors: ts.LanguageService['getApplicableRefactors']): ts.LanguageService['getApplicableRefactors'] {
	return (filePath, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			if (typeof positionOrRange === 'number') {
				const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, positionOrRange, isCodeActionsEnabled);
				if (generatePosition !== undefined) {
					return getApplicableRefactors(targetScript.id, generatePosition, preferences, triggerReason, kind, includeInteractiveActions);
				}
			}
			else {
				for (const [generatedStart, generatedEnd] of toGeneratedRanges(language, serviceScript, sourceScript, positionOrRange.pos, positionOrRange.end, isCodeActionsEnabled)) {
					return getApplicableRefactors(targetScript.id, { pos: generatedStart, end: generatedEnd }, preferences, triggerReason, kind, includeInteractiveActions);
				}
			}
			return [];
		}
		else {
			return getApplicableRefactors(fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions);
		}
	};
}
function getEditsForRefactor(language: Language<string>, getEditsForRefactor: ts.LanguageService['getEditsForRefactor']): ts.LanguageService['getEditsForRefactor'] {
	return (filePath, formatOptions, positionOrRange, refactorName, actionName, preferences, interactiveRefactorArguments) => {
		let edits: ts.RefactorEditInfo | undefined;
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			if (typeof positionOrRange === 'number') {
				const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, positionOrRange, isCodeActionsEnabled);
				if (generatePosition !== undefined) {
					edits = getEditsForRefactor(targetScript.id, formatOptions, generatePosition, refactorName, actionName, preferences, interactiveRefactorArguments);
				}
			}
			else {
				for (const [generatedStart, generatedEnd] of toGeneratedRanges(language, serviceScript, sourceScript, positionOrRange.pos, positionOrRange.end, isCodeActionsEnabled)) {
					edits = getEditsForRefactor(targetScript.id, formatOptions, { pos: generatedStart, end: generatedEnd }, refactorName, actionName, preferences, interactiveRefactorArguments);
				}
			}
		}
		else {
			edits = getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences, interactiveRefactorArguments);
		}
		if (edits) {
			edits.edits = transformFileTextChanges(language, edits.edits, false, isCodeActionsEnabled);
			return edits;
		}
	};
}
function getCombinedCodeFix(language: Language<string>, getCombinedCodeFix: ts.LanguageService['getCombinedCodeFix']): ts.LanguageService['getCombinedCodeFix'] {
	return (...args) => {
		const codeActions = getCombinedCodeFix(...args);
		codeActions.changes = transformFileTextChanges(language, codeActions.changes, false, isCodeActionsEnabled);
		return codeActions;
	};
}
function getRenameInfo(language: Language<string>, getRenameInfo: ts.LanguageService['getRenameInfo']): ts.LanguageService['getRenameInfo'] {
	return (filePath, position, options) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return {
				canRename: false,
				localizedErrorMessage: "Cannot rename"
			};
		}
		if (serviceScript) {
			let failed: ts.RenameInfoFailure | undefined;
			for (const [generateOffset] of toGeneratedOffsets(language, serviceScript, sourceScript, position, isRenameEnabled)) {
				const info = getRenameInfo(targetScript.id, generateOffset, options);
				if (info.canRename) {
					const span = transformTextSpan(sourceScript, language, serviceScript, info.triggerSpan, false, isRenameEnabled)?.[1];
					if (span) {
						info.triggerSpan = span;
						return info;
					}
				}
				else {
					failed = info;
				}
			}
			if (failed) {
				return failed;
			}
			return {
				canRename: false,
				localizedErrorMessage: 'Failed to get rename locations',
			};
		}
		else {
			return getRenameInfo(fileName, position, options);
		}
	};
}
function getCodeFixesAtPosition(language: Language<string>, getCodeFixesAtPosition: ts.LanguageService['getCodeFixesAtPosition']): ts.LanguageService['getCodeFixesAtPosition'] {
	return (filePath, start, end, errorCodes, formatOptions, preferences) => {
		let fixes: readonly ts.CodeFixAction[] = [];
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			const generateStart = toGeneratedOffset(language, serviceScript, sourceScript, start, isCodeActionsEnabled);
			const generateEnd = toGeneratedOffset(language, serviceScript, sourceScript, end, isCodeActionsEnabled);
			if (generateStart !== undefined && generateEnd !== undefined) {
				fixes = getCodeFixesAtPosition(
					targetScript.id,
					generateStart,
					generateEnd,
					errorCodes,
					formatOptions,
					preferences
				);
			}
		}
		else {
			fixes = getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences);
		}
		fixes = fixes.map(fix => {
			fix.changes = transformFileTextChanges(language, fix.changes, false, isCodeActionsEnabled);
			return fix;
		});
		return fixes;
	};
}
function getEncodedSemanticClassifications(language: Language<string>, getEncodedSemanticClassifications: ts.LanguageService['getEncodedSemanticClassifications']): ts.LanguageService['getEncodedSemanticClassifications'] {
	return (filePath, span, format) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return {
				spans: [],
				endOfLineState: 0
			};
		}
		if (serviceScript) {
			let start: number | undefined;
			let end: number | undefined;
			const map = language.maps.get(serviceScript.code, targetScript);
			for (const mapping of map.mappings) {
				// TODO reuse the logic from language service
				if (isSemanticTokensEnabled(mapping.data) && mapping.sourceOffsets[0] >= span.start && mapping.sourceOffsets[0] <= span.start + span.length) {
					start ??= mapping.generatedOffsets[0];
					end ??= mapping.generatedOffsets[mapping.generatedOffsets.length - 1] + (mapping.generatedLengths ?? mapping.lengths)[mapping.lengths.length - 1];
					start = Math.min(start, mapping.generatedOffsets[0]);
					end = Math.max(end, mapping.generatedOffsets[mapping.generatedOffsets.length - 1] + (mapping.generatedLengths ?? mapping.lengths)[mapping.lengths.length - 1]);
				}
			}
			start ??= 0;
			end ??= targetScript.snapshot.getLength();
			const mappingOffset = getMappingOffset(language, serviceScript);
			start += mappingOffset;
			end += mappingOffset;
			const result = getEncodedSemanticClassifications(targetScript.id, { start, length: end - start }, format);
			const spans: number[] = [];
			for (let i = 0; i < result.spans.length; i += 3) {
				for (const [_, sourceStart, sourceEnd] of toSourceRanges(sourceScript, language, serviceScript, result.spans[i], result.spans[i] + result.spans[i + 1], false, isSemanticTokensEnabled)) {
					spans.push(
						sourceStart,
						sourceEnd - sourceStart,
						result.spans[i + 2]
					);
					break;
				}
			}
			result.spans = spans;
			return result;
		}
		else {
			return getEncodedSemanticClassifications(fileName, span, format);
		}
	};
}
function getSyntacticDiagnostics(language: Language<string>, languageService: ts.LanguageService, getSyntacticDiagnostics: ts.LanguageService['getSyntacticDiagnostics']): ts.LanguageService['getSyntacticDiagnostics'] {
	return filePath => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		return getSyntacticDiagnostics(targetScript?.id ?? fileName)
			.map(d => transformDiagnostic(language, d, languageService.getProgram(), false))
			.filter(d => !!d)
			.filter(d => !serviceScript || language.scripts.get(d.file.fileName) === sourceScript);
	};
}
function getSemanticDiagnostics(language: Language<string>, languageService: ts.LanguageService, getSemanticDiagnostics: ts.LanguageService['getSemanticDiagnostics']): ts.LanguageService['getSemanticDiagnostics'] {
	return filePath => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		return getSemanticDiagnostics(targetScript?.id ?? fileName)
			.map(d => transformDiagnostic(language, d, languageService.getProgram(), false))
			.filter(d => !!d)
			.filter(d => !serviceScript || !d.file || language.scripts.get(d.file.fileName) === sourceScript);
	};
}
function getSuggestionDiagnostics(language: Language<string>, languageService: ts.LanguageService, getSuggestionDiagnostics: ts.LanguageService['getSuggestionDiagnostics']): ts.LanguageService['getSuggestionDiagnostics'] {
	return filePath => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		return getSuggestionDiagnostics(targetScript?.id ?? fileName)
			.map(d => transformDiagnostic(language, d, languageService.getProgram(), false))
			.filter(d => !!d)
			.filter(d => !serviceScript || !d.file || language.scripts.get(d.file.fileName) === sourceScript);
	};
}
function getDefinitionAndBoundSpan(language: Language<string>, getDefinitionAndBoundSpan: ts.LanguageService['getDefinitionAndBoundSpan']): ts.LanguageService['getDefinitionAndBoundSpan'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isDefinitionEnabled,
			(fileName, position) => getDefinitionAndBoundSpan(fileName, position),
			function* (result) {
				for (const ref of result.definitions ?? []) {
					yield [ref.fileName, ref.textSpan.start];
				}
			}
		);
		const textSpan = unresolved
			.map(s => transformSpan(language, fileName, s.textSpan, true, isDefinitionEnabled)?.textSpan)
			.filter(s => !!s)[0];
		if (!textSpan) {
			return;
		}
		const definitions = unresolved
			.map(s => s.definitions
				?.map(s => transformDocumentSpan(language, s, true, isDefinitionEnabled, s.fileName !== fileName))
				.filter(s => !!s)
				?? []
			)
			.flat();
		return {
			textSpan,
			definitions: dedupeDocumentSpans(definitions),
		};
	};
}
function findReferences(language: Language<string>, findReferences: ts.LanguageService['findReferences']): ts.LanguageService['findReferences'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isReferencesEnabled,
			(fileName, position) => findReferences(fileName, position),
			function* (result) {
				for (const ref of result) {
					for (const reference of ref.references) {
						yield [reference.fileName, reference.textSpan.start];
					}
				}
			}
		);
		const resolved: ts.ReferencedSymbol[] = unresolved
			.flat()
			.map(symbol => {
				const definition = transformDocumentSpan(language, symbol.definition, true, isDefinitionEnabled, true)!;
				return {
					definition,
					references: symbol.references
						.map(r => transformDocumentSpan(language, r, true, isReferencesEnabled))
						.filter(r => !!r),
				};
			});
		return resolved;
	};
}
function getDefinitionAtPosition(language: Language<string>, getDefinitionAtPosition: ts.LanguageService['getDefinitionAtPosition']): ts.LanguageService['getDefinitionAtPosition'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isDefinitionEnabled,
			(fileName, position) => getDefinitionAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			}
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, true, isDefinitionEnabled, s.fileName !== fileName))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}
function getTypeDefinitionAtPosition(language: Language<string>, getTypeDefinitionAtPosition: ts.LanguageService['getTypeDefinitionAtPosition']): ts.LanguageService['getTypeDefinitionAtPosition'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isTypeDefinitionEnabled,
			(fileName, position) => getTypeDefinitionAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			}
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, true, isTypeDefinitionEnabled))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}
function getImplementationAtPosition(language: Language<string>, getImplementationAtPosition: ts.LanguageService['getImplementationAtPosition']): ts.LanguageService['getImplementationAtPosition'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isImplementationEnabled,
			(fileName, position) => getImplementationAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			}
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, true, isImplementationEnabled))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}
function findRenameLocations(language: Language<string>, findRenameLocations: ts.LanguageService['findRenameLocations']): ts.LanguageService['findRenameLocations'] {
	return (filePath, position, findInStrings, findInComments, preferences) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isRenameEnabled,
			(fileName, position) => findRenameLocations(fileName, position, findInStrings, findInComments, preferences as ts.UserPreferences),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			}
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, false, isRenameEnabled))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}
function getReferencesAtPosition(language: Language<string>, getReferencesAtPosition: ts.LanguageService['getReferencesAtPosition']): ts.LanguageService['getReferencesAtPosition'] {
	return (filePath, position) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = linkedCodeFeatureWorker(
			language,
			fileName,
			position,
			isReferencesEnabled,
			(fileName, position) => getReferencesAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			}
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, true, isReferencesEnabled))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}
function getCompletionsAtPosition(language: Language<string>, getCompletionsAtPosition: ts.LanguageService['getCompletionsAtPosition']): ts.LanguageService['getCompletionsAtPosition'] {
	return (filePath, position, options, formattingSettings) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			let mainResult: ts.CompletionInfo | undefined;
			const additionalResults: ts.CompletionInfo[] = [];

			for (const [generatedOffset, mapping] of toGeneratedOffsets(language, serviceScript, sourceScript, position, isCompletionEnabled)) {
				const isAdditional = typeof mapping.data.completion === 'object' && mapping.data.completion.isAdditional;
				if (!isAdditional && mainResult?.entries.length) {
					continue;
				}
				const result = getCompletionsAtPosition(targetScript.id, generatedOffset, options, formattingSettings);
				if (!result) {
					continue;
				}
				if (typeof mapping.data.completion === 'object' && mapping.data.completion.onlyImport) {
					result.entries = result.entries.filter(entry => !!entry.sourceDisplay);
				}
				for (const entry of result.entries) {
					entry.replacementSpan = entry.replacementSpan && transformTextSpan(sourceScript, language, serviceScript, entry.replacementSpan, false, isCompletionEnabled)?.[1];
				}
				result.optionalReplacementSpan = result.optionalReplacementSpan
					&& transformTextSpan(sourceScript, language, serviceScript, result.optionalReplacementSpan, false, isCompletionEnabled)?.[1];
				if (isAdditional) {
					additionalResults.push(result);
				}
				else {
					mainResult = result;
				}
			}
			const results = additionalResults;
			if (mainResult) {
				results.unshift(mainResult);
			}
			if (results.length) {
				return {
					...results[0],
					entries: results
						.map(additionalResult => additionalResult.entries)
						.flat(),
				};
			}
		}
		else {
			return getCompletionsAtPosition(fileName, position, options, formattingSettings);
		}
	};
}
function getCompletionEntryDetails(language: Language<string>, getCompletionEntryDetails: ts.LanguageService['getCompletionEntryDetails']): ts.LanguageService['getCompletionEntryDetails'] {
	return (filePath, position, entryName, formatOptions, source, preferences, data) => {

		let details: ts.CompletionEntryDetails | undefined;

		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return undefined;
		}
		if (serviceScript) {
			const generatePosition = toGeneratedOffset(language, serviceScript, sourceScript, position, isCompletionEnabled);
			if (generatePosition !== undefined) {
				details = getCompletionEntryDetails(targetScript.id, generatePosition, entryName, formatOptions, source, preferences, data);
			}
		}
		else {
			return getCompletionEntryDetails(fileName, position, entryName, formatOptions, source, preferences, data);
		}

		if (details?.codeActions) {
			for (const codeAction of details.codeActions) {
				codeAction.changes = transformFileTextChanges(language, codeAction.changes, false, isCompletionEnabled);
			}
		}

		return details;
	};
}
function provideInlayHints(language: Language<string>, provideInlayHints: ts.LanguageService['provideInlayHints']): ts.LanguageService['provideInlayHints'] {
	return (filePath, span, preferences) => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
		if (targetScript?.associatedOnly) {
			return [];
		}
		if (serviceScript) {
			let start: number | undefined;
			let end: number | undefined;
			const map = language.maps.get(serviceScript.code, sourceScript);
			for (const mapping of map.mappings) {
				if (!isInlayHintsEnabled(mapping.data)) {
					continue;
				}
				let mappingStart = mapping.sourceOffsets[0];
				let genStart: number | undefined;
				let genEnd: number | undefined;
				if (mappingStart >= span.start && mappingStart <= span.start + span.length) {
					genStart = mapping.generatedOffsets[0];
					genEnd = mapping.generatedOffsets[mapping.generatedOffsets.length - 1]
						+ (mapping.generatedLengths ?? mapping.lengths)[mapping.generatedOffsets.length - 1];
				} else if (mappingStart < span.start && span.start < mappingStart + mapping.lengths[0]
					&& mapping.sourceOffsets.length == 1
					&& (!mapping.generatedLengths || mapping.generatedLengths[0] === mapping.lengths[0])
				) {
					genStart = mapping.generatedOffsets[0] + span.start - mappingStart;
					genEnd = Math.min(genStart + span.length, mapping.generatedOffsets[0] + mapping.lengths[0]);
				} else {
					continue;
				}
				start = Math.min(start ?? genStart, genStart);
				end = Math.max(end ?? genEnd, genEnd);
			}
			if (start === undefined || end === undefined) {
				start = 0;
				end = 0;
			}
			const mappingOffset = getMappingOffset(language, serviceScript);
			start += mappingOffset;
			end += mappingOffset;
			const result = provideInlayHints(targetScript.id, { start, length: end - start }, preferences);
			const hints: ts.InlayHint[] = [];
			for (const hint of result) {
				const sourcePosition = toSourceOffset(sourceScript, language, serviceScript, hint.position, isInlayHintsEnabled);
				if (sourcePosition !== undefined) {
					hints.push({
						...hint,
						position: sourcePosition[1],
					});
				}
			}
			return hints;
		}
		else {
			return provideInlayHints(fileName, span, preferences);
		}
	};
}
function getFileReferences(language: Language<string>, getFileReferences: ts.LanguageService['getFileReferences']): ts.LanguageService['getFileReferences'] {
	return filePath => {
		const fileName = filePath.replace(windowsPathReg, '/');
		const unresolved = getFileReferences(fileName);
		const resolved = unresolved
			.map(s => transformDocumentSpan(language, s, true, isReferencesEnabled))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}
function getNavigateToItems(language: Language<string>, getNavigateToItems: ts.LanguageService['getNavigateToItems']): ts.LanguageService['getNavigateToItems'] {
	return (...args) => {
		const unresolved = getNavigateToItems(...args);
		const resolved = unresolved
			.map(s => transformDocumentSpan(language, s, true, isReferencesEnabled))
			.filter(s => !!s);
		return dedupeDocumentSpans(resolved);
	};
}

function linkedCodeFeatureWorker<T>(
	language: Language<string>,
	fileName: string,
	position: number,
	filter: (data: CodeInformation) => boolean,
	worker: (fileName: string, position: number) => T | undefined,
	getLinkedCodes: (result: T) => Generator<[fileName: string, position: number]>
) {
	const results: T[] = [];
	const processedFilePositions = new Set<string>();
	const [serviceScript, targetScript, sourceScript] = getServiceScript(language, fileName);
	if (serviceScript) {
		for (const [generatedOffset] of toGeneratedOffsets(language, serviceScript, sourceScript, position, filter)) {
			process(targetScript.id, generatedOffset);
		}
	}
	else {
		process(fileName, position);
	}

	return results;

	function process(fileName: string, position: number) {
		if (processedFilePositions.has(fileName + ':' + position)) {
			return;
		}
		processedFilePositions.add(fileName + ':' + position);
		const result = worker(fileName, position);
		if (!result) {
			return;
		}
		results.push(result);
		for (const ref of getLinkedCodes(result)) {

			processedFilePositions.add(ref[0] + ':' + ref[1]);

			const [serviceScript] = getServiceScript(language, ref[0]);
			if (!serviceScript) {
				continue;
			}

			const linkedCodeMap = language.linkedCodeMaps.get(serviceScript.code);
			if (!linkedCodeMap) {
				continue;
			}

			const mappingOffset = getMappingOffset(language, serviceScript);
			for (const linkedCodeOffset of linkedCodeMap.getLinkedOffsets(ref[1] - mappingOffset)) {
				process(ref[0], linkedCodeOffset + mappingOffset);
			}
		}
	}
}

function displayPartsToString(displayParts: ts.SymbolDisplayPart[] | undefined) {
	if (displayParts) {
		return displayParts.map(displayPart => displayPart.text).join('');
	}
	return '';
}
