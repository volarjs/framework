import type { CodeInformation, SourceScript } from '@volar/language-core';
import { Language, shouldReportDiagnostics } from '@volar/language-core';
import type * as ts from 'typescript';
import type { TextChange } from "typescript";
import type { TypeScriptServiceScript } from '../..';
import { getServiceScript } from './utils';

const transformedDiagnostics = new WeakMap<ts.Diagnostic, ts.Diagnostic | undefined>();
const transformedSourceFile = new WeakSet<ts.SourceFile>();

/**
 * This file contains a number of facilities for transforming `ts.Diagnostic`s returned
 * from the  base TypeScript LanguageService, which reference locations in generated
 * TS code (e.g. the TypeScript codegen'd from the script portion of a .vue file) into locations
 * in the script portion of the .vue file.
 */
export function transformCallHierarchyItem(
	language: Language<string>,
	item: ts.CallHierarchyItem,
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean
): ts.CallHierarchyItem {
	const span = transformSpan(language, item.file, item.span, fallbackToAnyMatch, filter);
	const selectionSpan = transformSpan(language, item.file, item.selectionSpan, fallbackToAnyMatch, filter);
	return {
		...item,
		file: span?.fileName ?? item.file,
		span: span?.textSpan ?? { start: 0, length: 0 },
		selectionSpan: selectionSpan?.textSpan ?? { start: 0, length: 0 },
	};
}

export function transformDiagnostic<T extends ts.Diagnostic>(
	language: Language<string>,
	diagnostic: T,
	program: ts.Program | undefined,
	isTsc: boolean
): T | undefined {
	if (!transformedDiagnostics.has(diagnostic)) {
		transformedDiagnostics.set(diagnostic, undefined);

		const { relatedInformation } = diagnostic;
		if (relatedInformation) {
			diagnostic.relatedInformation = relatedInformation
				.map(d => transformDiagnostic(language, d, program, isTsc))
				.filter(d => !!d);
		}

		if (
			diagnostic.file !== undefined
			&& diagnostic.start !== undefined
			&& diagnostic.length !== undefined
		) {
			const [serviceScript] = getServiceScript(language, diagnostic.file.fileName);
			if (serviceScript) {
				const [sourceSpanFileName, sourceSpan] = transformTextSpan(
					undefined,
					language,
					serviceScript,
					{
						start: diagnostic.start,
						length: diagnostic.length
					},
					true,
					data => shouldReportDiagnostics(data, String(diagnostic.source), String(diagnostic.code))
				) ?? [];
				const actualDiagnosticFile = sourceSpanFileName
					? diagnostic.file.fileName === sourceSpanFileName
						? diagnostic.file
						: program?.getSourceFile(sourceSpanFileName)
					: undefined;
				if (sourceSpan && actualDiagnosticFile) {
					if (isTsc) {
						fillSourceFileText(language, diagnostic.file);
					}
					transformedDiagnostics.set(diagnostic, {
						...diagnostic,
						file: actualDiagnosticFile,
						start: sourceSpan.start,
						length: sourceSpan.length,
					});
				}
			}
			else {
				transformedDiagnostics.set(diagnostic, diagnostic);
			}
		}
		else {
			transformedDiagnostics.set(diagnostic, diagnostic);
		}
	}
	return transformedDiagnostics.get(diagnostic) as T | undefined;
}

// fix https://github.com/vuejs/language-tools/issues/4099 without `incremental`
export function fillSourceFileText(language: Language<string>, sourceFile: ts.SourceFile) {
	if (transformedSourceFile.has(sourceFile)) {
		return;
	}
	transformedSourceFile.add(sourceFile);
	const [serviceScript] = getServiceScript(language, sourceFile.fileName);
	if (serviceScript && !serviceScript.preventLeadingOffset) {
		const sourceScript = language.scripts.fromVirtualCode(serviceScript.code);
		sourceFile.text = sourceScript.snapshot.getText(0, sourceScript.snapshot.getLength())
			+ sourceFile.text.substring(sourceScript.snapshot.getLength());
	}
}

export function transformFileTextChanges(
	language: Language<string>,
	changes: readonly ts.FileTextChanges[],
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean
): ts.FileTextChanges[] {
	const changesPerFile: { [fileName: string]: TextChange[]; } = {};
	const newFiles = new Set<string>();
	for (const fileChanges of changes) {
		const [_, source] = getServiceScript(language, fileChanges.fileName);
		if (source) {
			fileChanges.textChanges.forEach(c => {
				const { fileName, textSpan } = transformSpan(language, fileChanges.fileName, c.span, fallbackToAnyMatch, filter) ?? {};
				if (fileName && textSpan) {
					(changesPerFile[fileName] ?? (changesPerFile[fileName] = [])).push({ ...c, span: textSpan });
				}
			});

		} else {
			const list = (changesPerFile[fileChanges.fileName] ?? (changesPerFile[fileChanges.fileName] = []));
			fileChanges.textChanges.forEach(c => {
				list.push(c);
			});
			if (fileChanges.isNewFile) {
				newFiles.add(fileChanges.fileName);
			}
		}
	}
	const result: ts.FileTextChanges[] = [];
	for (const fileName in changesPerFile) {
		result.push({
			fileName,
			isNewFile: newFiles.has(fileName),
			textChanges: changesPerFile[fileName]
		});
	}
	return result;
}

export function transformDocumentSpan<T extends ts.DocumentSpan>(
	language: Language<string>,
	documentSpan: T,
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean,
	shouldFallback?: boolean
): T | undefined {
	let textSpan = transformSpan(language, documentSpan.fileName, documentSpan.textSpan, fallbackToAnyMatch, filter);
	if (!textSpan && shouldFallback) {
		textSpan = {
			fileName: documentSpan.fileName,
			textSpan: { start: 0, length: 0 },
		};
	}
	if (!textSpan) {
		return;
	}
	const contextSpan = transformSpan(language, documentSpan.fileName, documentSpan.contextSpan, fallbackToAnyMatch, filter);
	const originalTextSpan = transformSpan(language, documentSpan.originalFileName, documentSpan.originalTextSpan, fallbackToAnyMatch, filter);
	const originalContextSpan = transformSpan(language, documentSpan.originalFileName, documentSpan.originalContextSpan, fallbackToAnyMatch, filter);
	return {
		...documentSpan,
		fileName: textSpan.fileName,
		textSpan: textSpan.textSpan,
		contextSpan: contextSpan?.textSpan,
		originalFileName: originalTextSpan?.fileName,
		originalTextSpan: originalTextSpan?.textSpan,
		originalContextSpan: originalContextSpan?.textSpan,
	};
}

export function transformSpan(
	language: Language<string>,
	fileName: string | undefined,
	textSpan: ts.TextSpan | undefined,
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean
): {
	fileName: string;
	textSpan: ts.TextSpan;
} | undefined {
	if (!fileName || !textSpan) {
		return;
	}
	const [serviceScript] = getServiceScript(language, fileName);
	if (serviceScript) {
		const [sourceSpanFileName, sourceSpan] = transformTextSpan(undefined, language, serviceScript, textSpan, fallbackToAnyMatch, filter) ?? [];
		if (sourceSpan && sourceSpanFileName) {
			return {
				fileName: sourceSpanFileName,
				textSpan: sourceSpan,
			};
		}
	}
	else {
		return {
			fileName,
			textSpan,
		};
	}
}

export function transformTextChange(
	sourceScript: SourceScript<string> | undefined,
	language: Language<string>,
	serviceScript: TypeScriptServiceScript,
	textChange: ts.TextChange,
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean
): [string, ts.TextChange] | undefined {
	const [sourceSpanFileName, sourceSpan] = transformTextSpan(sourceScript, language, serviceScript, textChange.span, fallbackToAnyMatch, filter) ?? [];
	if (sourceSpan && sourceSpanFileName) {
		return [sourceSpanFileName, {
			newText: textChange.newText,
			span: sourceSpan,
		}];
	}
	return undefined;
}

export function transformTextSpan(
	sourceScript: SourceScript<string> | undefined,
	language: Language<string>,
	serviceScript: TypeScriptServiceScript,
	textSpan: ts.TextSpan,
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean
): [string, ts.TextSpan] | undefined {
	const start = textSpan.start;
	const end = textSpan.start + textSpan.length;
	for (const [fileName, sourceStart, sourceEnd] of toSourceRanges(sourceScript, language, serviceScript, start, end, fallbackToAnyMatch, filter)) {
		return [fileName, {
			start: sourceStart,
			length: sourceEnd - sourceStart,
		}];
	}
}

export function toSourceOffset(
	sourceScript: SourceScript<string> | undefined,
	language: Language<string>,
	serviceScript: TypeScriptServiceScript,
	position: number,
	filter: (data: CodeInformation) => boolean
) {
	for (const source of toSourceOffsets(sourceScript, language, serviceScript, position, filter)) {
		return source;
	}
}

export function* toSourceRanges(
	sourceScript: SourceScript<string> | undefined,
	language: Language<string>,
	serviceScript: TypeScriptServiceScript,
	start: number,
	end: number,
	fallbackToAnyMatch: boolean,
	filter: (data: CodeInformation) => boolean
): Generator<[fileName: string, start: number, end: number]> {
	if (sourceScript) {
		const map = language.maps.get(serviceScript.code, sourceScript);
		for (const [sourceStart, sourceEnd] of map.toSourceRange(
			start - getMappingOffset(language, serviceScript),
			end - getMappingOffset(language, serviceScript),
			fallbackToAnyMatch,
			filter
		)) {
			yield [sourceScript.id, sourceStart, sourceEnd];
		}
	}
	else {
		for (const [sourceScript, map] of language.maps.forEach(serviceScript.code)) {
			for (const [sourceStart, sourceEnd] of map.toSourceRange(
				start - getMappingOffset(language, serviceScript),
				end - getMappingOffset(language, serviceScript),
				fallbackToAnyMatch,
				filter
			)) {
				yield [sourceScript.id, sourceStart, sourceEnd];
			}
		}
	}
}

export function* toSourceOffsets(
	sourceScript: SourceScript<string> | undefined,
	language: Language<string>,
	serviceScript: TypeScriptServiceScript,
	position: number,
	filter: (data: CodeInformation) => boolean
): Generator<[fileName: string, offset: number]> {
	if (sourceScript) {
		const map = language.maps.get(serviceScript.code, sourceScript);
		for (const [sourceOffset, mapping] of map.toSourceLocation(position - getMappingOffset(language, serviceScript))) {
			if (filter(mapping.data)) {
				yield [sourceScript.id, sourceOffset];
			}
		}
	}
	else {
		for (const [sourceScript, map] of language.maps.forEach(serviceScript.code)) {
			for (const [sourceOffset, mapping] of map.toSourceLocation(position - getMappingOffset(language, serviceScript))) {
				if (filter(mapping.data)) {
					yield [sourceScript.id, sourceOffset];
				}
			}
		}
	}
}

export function* toGeneratedRanges(
	language: Language,
	serviceScript: TypeScriptServiceScript,
	sourceScript: SourceScript<string>,
	start: number,
	end: number,
	filter: (data: CodeInformation) => boolean
) {
	const map = language.maps.get(serviceScript.code, sourceScript);
	for (const [generateStart, generateEnd] of map.toGeneratedRange(start, end, true, filter)) {
		yield [
			generateStart + getMappingOffset(language, serviceScript),
			generateEnd + getMappingOffset(language, serviceScript),
		] as const;
	}
}

export function toGeneratedOffset(
	language: Language,
	serviceScript: TypeScriptServiceScript,
	sourceScript: SourceScript<string>,
	position: number,
	filter: (data: CodeInformation) => boolean
) {
	for (const [generateOffset] of toGeneratedOffsets(language, serviceScript, sourceScript, position, filter)) {
		return generateOffset;
	}
}

export function* toGeneratedOffsets(
	language: Language,
	serviceScript: TypeScriptServiceScript,
	sourceScript: SourceScript<string>,
	position: number,
	filter: (data: CodeInformation) => boolean
) {
	const map = language.maps.get(serviceScript.code, sourceScript);
	for (const [generateOffset, mapping] of map.toGeneratedLocation(position)) {
		if (filter(mapping.data)) {
			yield [generateOffset + getMappingOffset(language, serviceScript), mapping] as const;
		}
	}
}

export function getMappingOffset(language: Language, serviceScript: TypeScriptServiceScript) {
	if (serviceScript.preventLeadingOffset) {
		return 0;
	}
	const sourceScript = language.scripts.fromVirtualCode(serviceScript.code);
	return sourceScript.snapshot.getLength();
}
