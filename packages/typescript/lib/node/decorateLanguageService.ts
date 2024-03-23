import {
	CodeInformation,
	Language,
	isCallHierarchyEnabled,
	isCodeActionsEnabled,
	isCompletionEnabled,
	isDefinitionEnabled,
	isHighlightEnabled,
	isHoverEnabled,
	isImplementationEnabled,
	isInlayHintsEnabled,
	isReferencesEnabled,
	isRenameEnabled,
	isSemanticTokensEnabled,
	isTypeDefinitionEnabled,
} from '@volar/language-core';
import type * as ts from 'typescript';
import { dedupeDocumentSpans, dedupeReferencedSymbols } from './dedupe';
import { getServiceScript, notEmpty } from './utils';
import { transformCallHierarchyItem, transformDiagnostic, transformDocumentSpan, transformFileTextChanges, transformSpan } from './transform';

export function decorateLanguageService(language: Language, languageService: ts.LanguageService) {

	// ignored methods

	const {
		getNavigationTree,
		getOutliningSpans,
	} = languageService;

	languageService.getNavigationTree = fileName => {
		const [serviceScript] = getServiceScript(language, fileName);
		if (serviceScript) {
			const tree = getNavigationTree(fileName);
			tree.childItems = undefined;
			return tree;
		}
		else {
			return getNavigationTree(fileName);
		}
	};
	languageService.getOutliningSpans = fileName => {
		const [serviceScript] = getServiceScript(language, fileName);
		if (serviceScript) {
			return [];
		}
		else {
			return getOutliningSpans(fileName);
		}
	};

	// methods

	const {
		findReferences,
		findRenameLocations,
		getCompletionEntryDetails,
		getCompletionsAtPosition,
		getDefinitionAndBoundSpan,
		getDefinitionAtPosition,
		getFileReferences,
		getImplementationAtPosition,
		getQuickInfoAtPosition,
		getReferencesAtPosition,
		getSemanticDiagnostics,
		getSyntacticDiagnostics,
		getSuggestionDiagnostics,
		getTypeDefinitionAtPosition,
		getEncodedSemanticClassifications,
		getDocumentHighlights,
		getApplicableRefactors,
		getEditsForRefactor,
		getRenameInfo,
		getCodeFixesAtPosition,
		prepareCallHierarchy,
		provideCallHierarchyIncomingCalls,
		provideCallHierarchyOutgoingCalls,
		provideInlayHints,
		organizeImports,
	} = languageService;

	languageService.prepareCallHierarchy = (fileName, position) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isCallHierarchyEnabled(mapping.data)) {
					const item = prepareCallHierarchy(fileName, generateOffset + sourceScript.snapshot.getLength());
					if (Array.isArray(item)) {
						return item.map(item => transformCallHierarchyItem(language, item, isCallHierarchyEnabled));
					}
					else if (item) {
						return transformCallHierarchyItem(language, item, isCallHierarchyEnabled);
					}
				}
			}
		}
		else {
			return prepareCallHierarchy(fileName, position);
		}
	};
	languageService.provideCallHierarchyIncomingCalls = (fileName, position) => {
		let calls: ts.CallHierarchyIncomingCall[] = [];
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isCallHierarchyEnabled(mapping.data)) {
					calls = provideCallHierarchyIncomingCalls(fileName, generateOffset + sourceScript.snapshot.getLength());
				}
			}
		}
		else {
			calls = provideCallHierarchyIncomingCalls(fileName, position);
		}
		return calls
			.map(call => {
				const from = transformCallHierarchyItem(language, call.from, isCallHierarchyEnabled);
				const fromSpans = call.fromSpans
					.map(span => transformSpan(language, call.from.file, span, isCallHierarchyEnabled)?.textSpan)
					.filter(notEmpty);
				return {
					from,
					fromSpans,
				};
			});
	};
	languageService.provideCallHierarchyOutgoingCalls = (fileName, position) => {
		let calls: ts.CallHierarchyOutgoingCall[] = [];
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isCallHierarchyEnabled(mapping.data)) {
					calls = provideCallHierarchyOutgoingCalls(fileName, generateOffset + sourceScript.snapshot.getLength());
				}
			}
		}
		else {
			calls = provideCallHierarchyOutgoingCalls(fileName, position);
		}
		return calls
			.map(call => {
				const to = transformCallHierarchyItem(language, call.to, isCallHierarchyEnabled);
				const fromSpans = call.fromSpans
					.map(span => transformSpan(language, fileName, span, isCallHierarchyEnabled)?.textSpan)
					.filter(notEmpty);
				return {
					to,
					fromSpans,
				};
			});
	};
	languageService.organizeImports = (args, formatOptions, preferences) => {
		const unresolved = organizeImports(args, formatOptions, preferences);
		const resolved = unresolved
			.map(changes => transformFileTextChanges(language, changes, isCodeActionsEnabled))
			.filter(notEmpty);
		return resolved;
	};
	languageService.getQuickInfoAtPosition = (fileName, position) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isHoverEnabled(mapping.data)) {
					const result = getQuickInfoAtPosition(fileName, generateOffset + sourceScript.snapshot.getLength());
					if (result) {
						const textSpan = transformSpan(language, fileName, result.textSpan, isHoverEnabled)?.textSpan;
						if (textSpan) {
							return {
								...result,
								textSpan,
							};
						}
					}
				}
			}
		}
		else {
			return getQuickInfoAtPosition(fileName, position);
		}
	};
	languageService.getDocumentHighlights = (fileName, position, filesToSearch) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isHighlightEnabled,
			position => getDocumentHighlights(fileName, position, filesToSearch),
			function* (result) {
				for (const ref of result) {
					for (const reference of ref.highlightSpans) {
						yield [reference.fileName ?? ref.fileName, reference.textSpan.start];
					}
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(highlights => {
				return {
					...highlights,
					highlightSpans: highlights.highlightSpans
						.map(span => {
							const textSpan = transformSpan(language, span.fileName ?? highlights.fileName, span.textSpan, isHighlightEnabled)?.textSpan;
							if (textSpan) {
								return {
									...span,
									contextSpan: transformSpan(language, span.fileName ?? highlights.fileName, span.contextSpan, isHighlightEnabled)?.textSpan,
									textSpan,
								};
							}
						})
						.filter(notEmpty),
				};
			});
		return resolved;
	};
	languageService.getApplicableRefactors = (fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos)) {
				if (isCodeActionsEnabled(mapping.data)) {
					const por = typeof positionOrRange === 'number'
						? generateOffset + sourceScript.snapshot.getLength()
						: {
							pos: generateOffset + sourceScript.snapshot.getLength(),
							end: generateOffset + positionOrRange.end - positionOrRange.pos + sourceScript.snapshot.getLength(),
						};
					return getApplicableRefactors(fileName, por, preferences, triggerReason, kind, includeInteractiveActions);
				}
			}
			return [];
		}
		else {
			return getApplicableRefactors(fileName, positionOrRange, preferences, triggerReason, kind, includeInteractiveActions);
		}
	};
	languageService.getEditsForRefactor = (fileName, formatOptions, positionOrRange, refactorName, actionName, preferences) => {
		let edits: ts.RefactorEditInfo | undefined;
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(typeof positionOrRange === 'number' ? positionOrRange : positionOrRange.pos)) {
				if (isCodeActionsEnabled(mapping.data)) {
					const por = typeof positionOrRange === 'number'
						? generateOffset + sourceScript.snapshot.getLength()
						: {
							pos: generateOffset + sourceScript.snapshot.getLength(),
							end: generateOffset + positionOrRange.end - positionOrRange.pos + sourceScript.snapshot.getLength(),
						};
					edits = getEditsForRefactor(fileName, formatOptions, por, refactorName, actionName, preferences);
				}
			}
		}
		else {
			edits = getEditsForRefactor(fileName, formatOptions, positionOrRange, refactorName, actionName, preferences);
		}
		if (edits) {
			edits.edits = edits.edits
				.map(edit => transformFileTextChanges(language, edit, isCodeActionsEnabled))
				.filter(notEmpty);
			return edits;
		}
	};
	languageService.getRenameInfo = (fileName, position, options) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isRenameEnabled(mapping.data)) {
					const info = getRenameInfo(fileName, generateOffset + sourceScript.snapshot.getLength(), options);
					if (info.canRename) {
						const span = transformSpan(language, fileName, info.triggerSpan, isRenameEnabled);
						if (span) {
							info.triggerSpan = span.textSpan;
							return info;
						}
					}
					else {
						return info;
					}
				}
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
	languageService.getCodeFixesAtPosition = (fileName, start, end, errorCodes, formatOptions, preferences) => {
		let fixes: readonly ts.CodeFixAction[] = [];
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateStart, mapping] of map.getGeneratedOffsets(start)) {
				if (isCodeActionsEnabled(mapping.data)) {
					for (const [generateEnd, mapping] of map.getGeneratedOffsets(end)) {
						if (isCodeActionsEnabled(mapping.data)) {
							fixes = getCodeFixesAtPosition(
								fileName,
								generateStart + sourceScript.snapshot.getLength(),
								generateEnd + sourceScript.snapshot.getLength(),
								errorCodes,
								formatOptions,
								preferences,
							);
							break;
						}
					}
					break;
				}
			}
		}
		else {
			fixes = getCodeFixesAtPosition(fileName, start, end, errorCodes, formatOptions, preferences);
		}
		fixes = fixes.map(fix => {
			fix.changes = fix.changes.map(edit => transformFileTextChanges(language, edit, isCodeActionsEnabled)).filter(notEmpty);
			return fix;
		});
		return fixes;
	};
	languageService.getEncodedSemanticClassifications = (fileName, span, format) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			let start: number | undefined;
			let end: number | undefined;
			for (const mapping of map.mappings) {
				if (isSemanticTokensEnabled(mapping.data) && mapping.sourceOffsets[0] >= span.start && mapping.sourceOffsets[0] <= span.start + span.length) {
					start ??= mapping.generatedOffsets[0];
					end ??= mapping.generatedOffsets[mapping.generatedOffsets.length - 1];
					start = Math.min(start, mapping.generatedOffsets[0]);
					end = Math.max(end, mapping.generatedOffsets[mapping.generatedOffsets.length - 1]);
				}
			}
			if (start === undefined || end === undefined) {
				start = 0;
				end = 0;
			}
			start += sourceScript.snapshot.getLength();
			end += sourceScript.snapshot.getLength();
			const result = getEncodedSemanticClassifications(fileName, { start, length: end - start }, format);
			const spans: number[] = [];
			for (let i = 0; i < result.spans.length; i += 3) {
				for (const [sourceStart, mapping] of map.getSourceOffsets(result.spans[i] - sourceScript.snapshot.getLength())) {
					if (isSemanticTokensEnabled(mapping.data)) {
						for (const [sourceEnd, mapping] of map.getSourceOffsets(result.spans[i] + result.spans[i + 1] - sourceScript.snapshot.getLength())) {
							if (isSemanticTokensEnabled(mapping.data)) {
								spans.push(
									sourceStart,
									sourceEnd - sourceStart,
									result.spans[i + 2]
								);
								break;
							}
						}
						break;
					}
				}
			}
			result.spans = spans;
			return result;
		}
		else {
			return getEncodedSemanticClassifications(fileName, span, format);
		}
	};
	languageService.getSyntacticDiagnostics = fileName => {
		return getSyntacticDiagnostics(fileName)
			.map(d => transformDiagnostic(language, d))
			.filter(notEmpty);
	};
	languageService.getSemanticDiagnostics = fileName => {
		return getSemanticDiagnostics(fileName)
			.map(d => transformDiagnostic(language, d))
			.filter(notEmpty);
	};
	languageService.getSuggestionDiagnostics = fileName => {
		return getSuggestionDiagnostics(fileName)
			.map(d => transformDiagnostic(language, d))
			.filter(notEmpty);
	};
	languageService.getDefinitionAndBoundSpan = (fileName, position) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isDefinitionEnabled,
			position => getDefinitionAndBoundSpan(fileName, position),
			function* (result) {
				for (const ref of result.definitions ?? []) {
					yield [ref.fileName, ref.textSpan.start];
				}
			},
		);
		const textSpan = unresolved
			.map(s => transformSpan(language, fileName, s.textSpan, isDefinitionEnabled)?.textSpan)
			.filter(notEmpty)[0];
		if (!textSpan) {
			return;
		}
		const definitions = unresolved
			.map(s => s.definitions
				?.map(s => transformDocumentSpan(language, s, isDefinitionEnabled, s.fileName !== fileName))
				.filter(notEmpty)
			)
			.filter(notEmpty)
			.flat();
		return {
			textSpan,
			definitions: dedupeDocumentSpans(definitions),
		};
	};
	languageService.findReferences = (fileName, position) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isReferencesEnabled,
			position => findReferences(fileName, position),
			function* (result) {
				for (const ref of result) {
					for (const reference of ref.references) {
						yield [reference.fileName, reference.textSpan.start];
					}
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(symbol => {
				const definition = transformDocumentSpan(language, symbol.definition, isDefinitionEnabled);
				if (definition) {
					return {
						definition,
						references: symbol.references
							.map(r => transformDocumentSpan(language, r, isReferencesEnabled))
							.filter(notEmpty),
					};
				}
			})
			.filter(notEmpty);
		return dedupeReferencedSymbols(resolved);
	};
	languageService.getDefinitionAtPosition = (fileName, position) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isDefinitionEnabled,
			position => getDefinitionAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, isDefinitionEnabled, s.fileName !== fileName))
			.filter(notEmpty);
		return dedupeDocumentSpans(resolved);
	};
	languageService.getTypeDefinitionAtPosition = (fileName, position) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isTypeDefinitionEnabled,
			position => getTypeDefinitionAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, isTypeDefinitionEnabled))
			.filter(notEmpty);
		return dedupeDocumentSpans(resolved);
	};
	languageService.getImplementationAtPosition = (fileName, position) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isImplementationEnabled,
			position => getImplementationAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, isImplementationEnabled))
			.filter(notEmpty);
		return dedupeDocumentSpans(resolved);
	};
	languageService.findRenameLocations = (fileName, position, findInStrings, findInComments, preferences) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isRenameEnabled,
			position => findRenameLocations(fileName, position, findInStrings, findInComments, preferences as ts.UserPreferences),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, isRenameEnabled))
			.filter(notEmpty);
		return dedupeDocumentSpans(resolved);
	};
	languageService.getReferencesAtPosition = (fileName, position) => {
		const unresolved = linkedCodeFeatureWorker(
			fileName,
			position,
			isReferencesEnabled,
			position => getReferencesAtPosition(fileName, position),
			function* (result) {
				for (const ref of result) {
					yield [ref.fileName, ref.textSpan.start];
				}
			},
		);
		const resolved = unresolved
			.flat()
			.map(s => transformDocumentSpan(language, s, isReferencesEnabled))
			.filter(notEmpty);
		return dedupeDocumentSpans(resolved);
	};
	languageService.getCompletionsAtPosition = (fileName, position, options, formattingSettings) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			let mainResult: ts.CompletionInfo | undefined;
			let additionalResults: ts.CompletionInfo[] = [];
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isCompletionEnabled(mapping.data)) {
					const isAdditional = typeof mapping.data.completion === 'object' && mapping.data.completion.isAdditional;
					if (!isAdditional && mainResult) {
						continue;
					}
					const result = getCompletionsAtPosition(fileName, generateOffset + sourceScript.snapshot.getLength(), options, formattingSettings);
					if (result) {
						for (const entry of result.entries) {
							entry.replacementSpan = transformSpan(language, fileName, entry.replacementSpan, isCompletionEnabled)?.textSpan;
						}
						result.optionalReplacementSpan = transformSpan(language, fileName, result.optionalReplacementSpan, isCompletionEnabled)?.textSpan;
						if (isAdditional) {
							additionalResults.push(result);
						}
						else {
							mainResult = result;
						}
					}
				}
			}
			if (!mainResult && additionalResults.length) {
				mainResult = additionalResults.shift();
			}
			if (mainResult) {
				return {
					...mainResult,
					entries: [
						...mainResult.entries,
						...additionalResults.map(additionalResult => additionalResult.entries).flat(),
					],
				};
			}
		}
		else {
			return getCompletionsAtPosition(fileName, position, options, formattingSettings);
		}
	};
	languageService.getCompletionEntryDetails = (fileName, position, entryName, formatOptions, source, preferences, data) => {

		let details: ts.CompletionEntryDetails | undefined;

		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (isCompletionEnabled(mapping.data)) {
					details = getCompletionEntryDetails(fileName, generateOffset + sourceScript.snapshot.getLength(), entryName, formatOptions, source, preferences, data);
					break;
				}
			}
		}
		else {
			return getCompletionEntryDetails(fileName, position, entryName, formatOptions, source, preferences, data);
		}

		if (details?.codeActions) {
			for (const codeAction of details.codeActions) {
				codeAction.changes = codeAction.changes.map(edit => transformFileTextChanges(language, edit, isCompletionEnabled)).filter(notEmpty);
			}
		}

		return details;
	};
	languageService.provideInlayHints = (fileName, span, preferences) => {
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			let start: number | undefined;
			let end: number | undefined;
			for (const mapping of map.mappings) {
				if (isInlayHintsEnabled(mapping.data) && mapping.sourceOffsets[0] >= span.start && mapping.sourceOffsets[0] <= span.start + span.length) {
					start ??= mapping.generatedOffsets[0];
					end ??= mapping.generatedOffsets[mapping.generatedOffsets.length - 1];
					start = Math.min(start, mapping.generatedOffsets[0]);
					end = Math.max(end, mapping.generatedOffsets[mapping.generatedOffsets.length - 1]);
				}
			}
			if (start === undefined || end === undefined) {
				start = 0;
				end = 0;
			}
			start += sourceScript.snapshot.getLength();
			end += sourceScript.snapshot.getLength();
			const result = provideInlayHints(fileName, { start, length: end - start }, preferences);
			const hints: ts.InlayHint[] = [];
			for (const hint of result) {
				for (const [sourcePosition, mapping] of map.getSourceOffsets(hint.position - sourceScript.snapshot.getLength())) {
					if (isInlayHintsEnabled(mapping.data)) {
						hints.push({
							...hint,
							position: sourcePosition,
						});
						break;
					}
				}
			}
			return hints;
		}
		else {
			return provideInlayHints(fileName, span, preferences);
		}
	};
	languageService.getFileReferences = fileName => {
		const unresolved = getFileReferences(fileName);
		const resolved = unresolved
			.map(s => transformDocumentSpan(language, s, isReferencesEnabled))
			.filter(notEmpty);
		return dedupeDocumentSpans(resolved);
	};

	function linkedCodeFeatureWorker<T>(
		fileName: string,
		position: number,
		filter: (data: CodeInformation) => boolean,
		worker: (position: number) => T | undefined,
		getLinkedCodes: (result: T) => Generator<[fileName: string, position: number]>,
	) {

		let results: T[] = [];

		const processedFilePositions = new Set<string>();
		const [serviceScript, sourceScript, map] = getServiceScript(language, fileName);
		if (serviceScript) {
			for (const [generateOffset, mapping] of map.getGeneratedOffsets(position)) {
				if (filter(mapping.data)) {
					process(fileName, generateOffset + sourceScript.snapshot.getLength());
				}
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
			const result = worker(position);
			if (!result) {
				return;
			}
			results = results.concat(result);
			for (const ref of getLinkedCodes(result)) {

				processedFilePositions.add(ref[0] + ':' + ref[1]);

				const [serviceScript, sourceScript] = getServiceScript(language, ref[0]);
				if (!serviceScript) {
					continue;
				}

				const linkedCodeMap = language.linkedCodeMaps.get(serviceScript.code);
				if (!linkedCodeMap) {
					continue;
				}

				for (const linkedCodeOffset of linkedCodeMap.getLinkedOffsets(ref[1] - sourceScript.snapshot.getLength())) {
					process(ref[0], linkedCodeOffset + sourceScript.snapshot.getLength());
				}
			}
		}
	}
}
